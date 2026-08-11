#!/usr/bin/env python3
"""
ios-debug-daemon.py — headless iOS Simulator debug sidecar.

A long-lived, stdio JSON-RPC daemon that drives LLDB's Python SB API against
apps running on the booted iOS Simulator. It is designed to be spawned by a
Node MCP server as the iOS backend of a cross-platform runtime debugger (the
Android side speaks JDWP natively).

Runtime requirement
-------------------
Must run under Xcode's Python with the LLDB bindings on PYTHONPATH:

    PYTHONPATH="$(xcrun lldb -P)" xcrun python3 scripts/ios-debug-daemon.py

Wire protocol (newline-delimited JSON, one object per line)
-----------------------------------------------------------
Request:  {"id": <int>, "method": "<verb>", "params": {...}}
Response: {"id": <int>, "ok": true,  "result": {...}}
     or:  {"id": <int>, "ok": false, "error": "<message>"}

stdin  -> requests (one JSON object per line)
stdout -> responses (one JSON object per line, NOTHING else)
stderr -> logs / diagnostics only

Design notes
------------
* One process holds ONE lldb.SBDebugger with SetAsync(True).
* Each attached app is a "session" keyed by a string sessionId, owning its own
  SBTarget / SBProcess.
* A background SBListener thread drains process *state* events into a
  per-session, in-memory event queue tagged with a monotonically increasing
  cursor. The protocol is strictly poll-based: `poll` never blocks; the agent
  advances a cursor and we return everything at/after it.

Only the Python standard library and the `lldb` module are used.
"""

import sys
import json
import threading
import subprocess
import traceback
import itertools

# ---------------------------------------------------------------------------
# LLDB import guard — fail loudly, in-protocol, if the bindings are missing.
# ---------------------------------------------------------------------------
try:
    import lldb  # type: ignore
except Exception as exc:  # pragma: no cover - environment dependent
    # We cannot know request ids yet, so emit a single well-formed error line
    # and exit. The Node side can detect this on the very first read.
    sys.stdout.write(
        json.dumps(
            {
                "id": None,
                "ok": False,
                "error": (
                    "lldb Python bindings unavailable: %s. "
                    'Run with: PYTHONPATH="$(xcrun lldb -P)" xcrun python3 '
                    "scripts/ios-debug-daemon.py" % exc
                ),
            }
        )
        + "\n"
    )
    sys.stdout.flush()
    sys.exit(1)


def log(*args):
    """Diagnostics go to stderr only — stdout is reserved for the protocol."""
    print("[ios-debug-daemon]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Exceptions carrying a client-facing message.
# ---------------------------------------------------------------------------
class RpcError(Exception):
    """An error whose message is safe to send back to the client verbatim."""


# ---------------------------------------------------------------------------
# Session — one attached process + its event queue + listener thread.
# ---------------------------------------------------------------------------
class Session:
    """Owns an SBTarget/SBProcess pair and a poll-model event queue."""

    def __init__(self, session_id, debugger, target, process, listener):
        self.id = session_id
        self.debugger = debugger
        self.target = target
        self.process = process

        # Event queue: list of (cursor, event_dict). Guarded by _lock.
        self._events = []
        self._cursor = itertools.count(1)  # cursors start at 1
        self._lock = threading.Lock()

        # objectId registry: stable id -> SBValue, so `inspect` can resolve a
        # value referenced by a previous pauseState/eval/inspect result.
        self._objects = {}
        self._object_ids = itertools.count(1)

        # IMPORTANT: reuse the SAME SBListener that was passed to
        # AttachToProcessWithID. The process's state-changed events are routed
        # to whichever listener owns the attach; creating a second listener
        # here would silently swallow every stop event (and, empirically, also
        # wedges process.Continue()). We re-assert the subscription to be safe.
        self._listener = listener
        self.process.GetBroadcaster().AddListener(
            self._listener, lldb.SBProcess.eBroadcastBitStateChanged
        )

        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._listen_loop, name="listener-%s" % session_id, daemon=True
        )
        self._thread.start()

    # -- object registry ---------------------------------------------------
    def register_object(self, sbvalue):
        """Assign and remember a stable objectId for an object-typed SBValue."""
        oid = "obj-%d" % next(self._object_ids)
        self._objects[oid] = sbvalue
        return oid

    def resolve_object(self, oid):
        val = self._objects.get(oid)
        if val is None:
            raise RpcError("unknown objectId: %s" % oid)
        return val

    # -- event queue -------------------------------------------------------
    def _push_event(self, event):
        with self._lock:
            cur = next(self._cursor)
            self._events.append((cur, event))

    def drain(self, from_cursor):
        """Return events with cursor >= from_cursor and the next cursor value."""
        with self._lock:
            out = [ev for (c, ev) in self._events if c >= from_cursor]
            # nextCursor = highest cursor seen + 1, or from_cursor if none yet.
            if self._events:
                next_cursor = self._events[-1][0] + 1
            else:
                next_cursor = max(from_cursor, 1)
            return out, next_cursor

    # -- listener loop -----------------------------------------------------
    def _listen_loop(self):
        """Background thread: translate SB state changes into queue events."""
        event = lldb.SBEvent()
        while not self._stop.is_set():
            # Wait up to 1s so we can observe the stop flag periodically.
            if not self._listener.WaitForEvent(1, event):
                continue
            if not lldb.SBProcess.EventIsProcessEvent(event):
                continue
            state = lldb.SBProcess.GetStateFromEvent(event)
            try:
                self._handle_state(state)
            except Exception as exc:  # pragma: no cover - defensive
                log("listener error:", exc)

    def _handle_state(self, state):
        if state == lldb.eStateExited:
            self._push_event({"kind": "EXITED", "threadId": None})
            return
        if state != lldb.eStateStopped:
            # running / stepping / launching etc. — not surfaced as events.
            return

        # Stopped: find the thread that actually caused the stop.
        thread = self._selected_stop_thread()
        if thread is None:
            self._push_event({"kind": "STOPPED", "threadId": None})
            return

        kind = self._classify_stop(thread)
        self._push_event(
            {
                "kind": kind,
                "threadId": thread.GetThreadID(),
                "location": self._frame_location(thread.GetFrameAtIndex(0)),
            }
        )

    def _selected_stop_thread(self):
        """Prefer a thread whose stop reason is meaningful over a plain one."""
        meaningful = (
            lldb.eStopReasonBreakpoint,
            lldb.eStopReasonException,
            lldb.eStopReasonPlanComplete,
            lldb.eStopReasonWatchpoint,
            lldb.eStopReasonSignal,
        )
        fallback = None
        for i in range(self.process.GetNumThreads()):
            t = self.process.GetThreadAtIndex(i)
            reason = t.GetStopReason()
            if reason in meaningful:
                return t
            if reason != lldb.eStopReasonNone and fallback is None:
                fallback = t
        return fallback or (
            self.process.GetThreadAtIndex(0)
            if self.process.GetNumThreads()
            else None
        )

    @staticmethod
    def _classify_stop(thread):
        reason = thread.GetStopReason()
        if reason == lldb.eStopReasonBreakpoint:
            return "BREAKPOINT_HIT"
        if reason == lldb.eStopReasonException:
            return "EXCEPTION"
        if reason == lldb.eStopReasonPlanComplete:
            return "STEP"
        return "STOPPED"

    @staticmethod
    def _frame_location(frame):
        if not frame or not frame.IsValid():
            return None
        line_entry = frame.GetLineEntry()
        file_spec = line_entry.GetFileSpec()
        return {
            "file": file_spec.GetFilename() if file_spec.IsValid() else None,
            "line": line_entry.GetLine() if line_entry.IsValid() else None,
            "function": frame.GetFunctionName(),
        }

    # -- teardown ----------------------------------------------------------
    def close(self, detach=True):
        self._stop.set()
        if detach and self.process and self.process.IsValid():
            try:
                self.process.Detach()
            except Exception as exc:  # pragma: no cover
                log("detach error:", exc)
        # Give the listener thread a moment to observe the stop flag.
        self._thread.join(timeout=2)
        try:
            self.debugger.DeleteTarget(self.target)
        except Exception as exc:  # pragma: no cover
            log("DeleteTarget error:", exc)


# ---------------------------------------------------------------------------
# Daemon — owns the debugger and dispatches verbs.
# ---------------------------------------------------------------------------
class Daemon:
    def __init__(self):
        lldb.SBDebugger.Initialize()
        self.debugger = lldb.SBDebugger.Create()
        self.debugger.SetAsync(True)
        self.sessions = {}
        self._session_ids = itertools.count(1)

    # -- helpers -----------------------------------------------------------
    def _session(self, params):
        sid = params.get("sessionId")
        sess = self.sessions.get(sid)
        if sess is None:
            raise RpcError("unknown sessionId: %s" % sid)
        return sess

    @staticmethod
    def _thread_by_id(process, thread_id):
        if thread_id is None:
            raise RpcError("threadId is required")
        t = process.GetThreadByID(int(thread_id))
        if not t or not t.IsValid():
            raise RpcError("no such thread: %s" % thread_id)
        return t

    @staticmethod
    def _booted_pid_for_bundle(bundle_id):
        """Ask simctl for the pid of a running app on the booted simulator."""
        try:
            out = subprocess.check_output(
                ["xcrun", "simctl", "spawn", "booted", "launchctl", "list"],
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except Exception:
            out = ""
        # launchctl list lines: "<pid>\t<status>\tUIKitApplication:<bundle>[...]"
        for line in out.splitlines():
            if bundle_id in line:
                cols = line.split("\t")
                if cols and cols[0].strip().isdigit():
                    return int(cols[0].strip())
        return None

    # -- object/value serialization ---------------------------------------
    def _value_is_object(self, sbvalue):
        """Heuristic: object-like values are worth an objectId for inspect."""
        if sbvalue is None or not sbvalue.IsValid():
            return False
        # A value that has children (struct/class/array/dict) is inspectable.
        return sbvalue.MightHaveChildren() and sbvalue.GetNumChildren() > 0

    def _serialize_value(self, session, sbvalue, want_object_id=True):
        """Render an SBValue to {name?, type, value, objectId?}."""
        type_name = sbvalue.GetTypeName() or sbvalue.GetDisplayTypeName() or ""
        # Prefer summary (e.g. "hello" for String), fall back to raw value.
        value = sbvalue.GetSummary()
        if value is None:
            value = sbvalue.GetValue()
        out = {"type": type_name, "value": value}
        if want_object_id and self._value_is_object(sbvalue):
            out["objectId"] = session.register_object(sbvalue)
        return out

    # -- verb implementations ---------------------------------------------
    def ping(self, params):
        return {"lldb": True, "version": lldb.SBDebugger.GetVersionString()}

    def attach(self, params):
        bundle_id = params.get("bundleId")
        if not bundle_id:
            raise RpcError("bundleId is required")
        launch = bool(params.get("launch"))
        # `wait` only meaningful with launch; default True so we get the
        # suspended pid from --wait-for-debugger.
        wait = params.get("wait", True)

        pid = None
        if launch:
            cmd = ["xcrun", "simctl", "launch"]
            if wait:
                cmd.append("--wait-for-debugger")
            cmd += ["booted", bundle_id]
            try:
                out = subprocess.check_output(
                    cmd, stderr=subprocess.STDOUT, text=True
                )
            except subprocess.CalledProcessError as exc:
                raise RpcError(
                    "simctl launch failed: %s" % (exc.output or exc).strip()
                )
            # Output: "<bundle>: <pid>"
            pid = self._parse_launch_pid(out)
            if pid is None:
                raise RpcError("could not parse pid from simctl launch: %r" % out)
        else:
            pid = self._booted_pid_for_bundle(bundle_id)
            if pid is None:
                raise RpcError(
                    "no running process found for %s on booted simulator "
                    "(pass launch:true to launch it)" % bundle_id
                )

        target = self.debugger.CreateTarget("")
        if not target.IsValid():
            raise RpcError("failed to create SBTarget")

        err = lldb.SBError()
        # Use a per-session listener for the attach so the session's background
        # thread receives the process's state-changed events (see Session).
        sid = "sess-%d" % next(self._session_ids)
        listener = lldb.SBListener("session-%s" % sid)
        process = target.AttachToProcessWithID(listener, pid, err)

        if err.Fail() or not process.IsValid():
            msg = err.GetCString() or "attach failed"
            self.debugger.DeleteTarget(target)
            raise RpcError(self._map_attach_error(msg))

        self.sessions[sid] = Session(sid, self.debugger, target, process, listener)
        log("attached", sid, "bundle", bundle_id, "pid", pid)
        return {"sessionId": sid, "pid": pid}

    @staticmethod
    def _parse_launch_pid(out):
        # e.g. "com.example.App: 54321"
        for tok in out.replace(":", " ").split():
            if tok.strip().isdigit():
                return int(tok.strip())
        return None

    @staticmethod
    def _map_attach_error(msg):
        """Translate LLDB's opaque attach failures into actionable messages."""
        low = msg.lower()
        if (
            "get-task-allow" in low
            or "not allowed to attach" in low
            or "operation not permitted" in low
            or "unable to attach" in low
            or "security" in low
            or "denied" in low
            or "entitlement" in low
        ):
            return (
                "app is not a debug build (get-task-allow) — only Debug-config "
                "builds are attachable [lldb: %s]" % msg
            )
        return "attach failed: %s" % msg

    def setBreakpoint(self, params):
        sess = self._session(params)
        file = params.get("file")
        line = params.get("line")
        if not file or line is None:
            raise RpcError("file and line are required")
        bp = sess.target.BreakpointCreateByLocation(str(file), int(line))
        return {
            "breakpointId": bp.GetID(),
            "verified": bp.GetNumLocations() > 0,
        }

    def setFunctionBreakpoint(self, params):
        sess = self._session(params)
        symbol = params.get("symbol")
        if not symbol:
            raise RpcError("symbol is required")
        bp = sess.target.BreakpointCreateByName(str(symbol))
        return {
            "breakpointId": bp.GetID(),
            "verified": bp.GetNumLocations() > 0,
        }

    def catchException(self, params):
        sess = self._session(params)
        language = (params.get("language") or "swift").lower()
        lang = (
            lldb.eLanguageTypeSwift
            if language == "swift"
            else lldb.eLanguageTypeObjC
        )
        bp = sess.target.BreakpointCreateForException(lang, False, True)
        return {"breakpointId": bp.GetID()}

    def removeBreakpoint(self, params):
        sess = self._session(params)
        bp_id = params.get("breakpointId")
        if bp_id is None:
            raise RpcError("breakpointId is required")
        ok = sess.target.BreakpointDelete(int(bp_id))
        if not ok:
            raise RpcError("no breakpoint with id %s" % bp_id)
        return {}

    def poll(self, params):
        sess = self._session(params)
        cursor = int(params.get("cursor", 1))
        events, next_cursor = sess.drain(cursor)
        return {"events": events, "nextCursor": next_cursor}

    def pauseState(self, params):
        sess = self._session(params)
        thread = self._thread_by_id(sess.process, params.get("threadId"))
        frames = []
        for i in range(thread.GetNumFrames()):
            frame = thread.GetFrameAtIndex(i)
            loc = Session._frame_location(frame)
            locals_out = []
            # arguments=True, locals=True, statics=False, in_scope_only=True
            variables = frame.GetVariables(True, True, False, True)
            for j in range(variables.GetSize()):
                v = variables.GetValueAtIndex(j)
                entry = {"name": v.GetName()}
                entry.update(self._serialize_value(sess, v))
                locals_out.append(entry)
            frames.append(
                {
                    "index": i,
                    "function": frame.GetFunctionName(),
                    "file": (loc or {}).get("file"),
                    "line": (loc or {}).get("line"),
                    "locals": locals_out,
                }
            )
        return {"frames": frames}

    def inspect(self, params):
        sess = self._session(params)
        oid = params.get("objectId")
        max_depth = int(params.get("maxDepth", 1))
        root = sess.resolve_object(oid)
        seen = set()
        return self._inspect_value(sess, root, max_depth, seen)

    def _inspect_value(self, sess, sbvalue, depth, seen):
        type_name = sbvalue.GetTypeName() or ""
        value = sbvalue.GetSummary() or sbvalue.GetValue()
        node = {"type": type_name, "value": value, "nested": {}}

        if depth <= 0:
            return node

        # Cycle guard: use the load address / value id as identity.
        addr = sbvalue.GetLoadAddress()
        ident = addr if addr != lldb.LLDB_INVALID_ADDRESS else id(sbvalue)
        if ident in seen:
            return node
        seen.add(ident)

        n = min(sbvalue.GetNumChildren(), 256)  # cap fan-out
        for i in range(n):
            child = sbvalue.GetChildAtIndex(i)
            if not child.IsValid():
                continue
            name = child.GetName() or ("[%d]" % i)
            child_out = self._serialize_value(sess, child)
            node["nested"][name] = child_out
        return node

    def eval(self, params):
        sess = self._session(params)
        thread = self._thread_by_id(sess.process, params.get("threadId"))
        expr = params.get("expr")
        if not expr:
            raise RpcError("expr is required")
        frame = thread.GetSelectedFrame()
        if not frame or not frame.IsValid():
            frame = thread.GetFrameAtIndex(0)
        val = frame.EvaluateExpression(str(expr))
        err = val.GetError()
        if err.Fail():
            raise RpcError("eval error: %s" % (err.GetCString() or "unknown"))
        return self._serialize_value(sess, val)

    def setVar(self, params):
        sess = self._session(params)
        thread = self._thread_by_id(sess.process, params.get("threadId"))
        name = params.get("name")
        value = params.get("value")
        if name is None or value is None:
            raise RpcError("name and value are required")
        frame = thread.GetSelectedFrame()
        if not frame or not frame.IsValid():
            frame = thread.GetFrameAtIndex(0)
        # Resolve the variable in the current frame by name.
        var = frame.FindVariable(str(name))
        if not var or not var.IsValid():
            # Fall back to a broader value lookup (e.g. self.x paths).
            var = frame.GetValueForVariablePath(str(name))
        if not var or not var.IsValid():
            raise RpcError("no such variable in frame: %s" % name)
        err = lldb.SBError()
        ok = var.SetValueFromCString(str(value), err)
        if ok and err.Success():
            return {}

        # Swift value types (Int, String, structs) frequently reject
        # SetValueFromCString with "Invalid encoding" because the Swift type
        # system doesn't expose a C string encoder. Fall back to an
        # eval-based assignment, which routes through the Swift expression
        # compiler and works for mutable (`var`) locals. Immutable (`let`)
        # locals will (correctly) fail here with an "is immutable" error.
        primary_err = err.GetCString() or "unknown error"
        assign = frame.EvaluateExpression("%s = %s" % (name, value))
        aerr = assign.GetError()
        if aerr.Success():
            return {}
        raise RpcError(
            "setVar failed: SetValueFromCString: %s; eval-assign: %s"
            % (primary_err, aerr.GetCString() or "unknown error")
        )

    def step(self, params):
        sess = self._session(params)
        action = (params.get("action") or "").upper()
        if action == "RESUME":
            err = sess.process.Continue()
            if err.Fail():
                raise RpcError("continue failed: %s" % err.GetCString())
            return {}
        thread = self._thread_by_id(sess.process, params.get("threadId"))
        if action == "OVER":
            thread.StepOver()
        elif action == "INTO":
            thread.StepInto()
        elif action == "OUT":
            thread.StepOut()
        else:
            raise RpcError(
                "unknown step action: %s (OVER|INTO|OUT|RESUME)" % action
            )
        return {}

    def detach(self, params):
        sess = self._session(params)
        sess.close(detach=True)
        del self.sessions[sess.id]
        return {}

    def shutdown(self, params):
        for sess in list(self.sessions.values()):
            try:
                sess.close(detach=True)
            except Exception as exc:  # pragma: no cover
                log("shutdown session close error:", exc)
        self.sessions.clear()
        lldb.SBDebugger.Destroy(self.debugger)
        lldb.SBDebugger.Terminate()
        return {"bye": True}

    # -- dispatch ----------------------------------------------------------
    _VERBS = {
        "ping",
        "attach",
        "setBreakpoint",
        "setFunctionBreakpoint",
        "catchException",
        "removeBreakpoint",
        "poll",
        "pauseState",
        "inspect",
        "eval",
        "setVar",
        "step",
        "detach",
        "shutdown",
    }

    def dispatch(self, method, params):
        if method not in self._VERBS:
            raise RpcError("unknown method: %s" % method)
        return getattr(self, method)(params or {})


# ---------------------------------------------------------------------------
# Main loop — read requests line-by-line, dispatch, write one response line.
# ---------------------------------------------------------------------------
def main():
    daemon = Daemon()
    log("ready — lldb", lldb.SBDebugger.GetVersionString())

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}
            result = daemon.dispatch(method, params)
            resp = {"id": req_id, "ok": True, "result": result}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            if method == "shutdown":
                break
        except RpcError as exc:
            _write_error(req_id, str(exc))
        except json.JSONDecodeError as exc:
            _write_error(req_id, "invalid JSON: %s" % exc)
        except Exception as exc:  # pragma: no cover - defensive
            log("unhandled error:\n" + traceback.format_exc())
            _write_error(req_id, "internal error: %s" % exc)

    log("stdin closed — exiting")


def _write_error(req_id, message):
    sys.stdout.write(
        json.dumps({"id": req_id, "ok": False, "error": message}) + "\n"
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
