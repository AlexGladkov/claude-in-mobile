// Live smoke of the unified DebugController (the layer the MCP `debug` tool
// drives) against a debuggable Android app.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DebugController } from "../dist/debug/controller.js";

const pexec = promisify(execFile);
const pkg = process.argv[2] ?? "tech.mobiledeveloper.jethabit.debug";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (deviceId) => async (args) =>
  (await pexec("adb", deviceId ? ["-s", deviceId, ...args] : args)).stdout;
const tryAdb = async (args) => { try { await adb()(args); } catch {} };

const ctrl = new DebugController((d) => adb(d));

const att = await ctrl.attach({ platform: "android", app: pkg });
console.log("attach:", JSON.stringify(att));

const bp = await ctrl.setBreakpoint(att.sessionId, { className: "android.app.Activity", method: "onResume" });
console.log("break:", JSON.stringify(bp));

const activity = (await adb()(["shell", "cmd", "package", "resolve-activity", "--brief", pkg])).trim().split(/\s+/).pop();
await tryAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
await sleep(1000);
await tryAdb(["shell", "am", "start", "-n", activity]);

let cursor = 0, hit = null;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const { events, nextCursor } = await ctrl.poll(att.sessionId, cursor);
  cursor = nextCursor;
  hit = events.find((e) => e.kind === "BREAKPOINT_HIT");
  if (hit) break;
}
if (!hit) { console.log("no hit"); await ctrl.disposeAll(); process.exit(1); }
console.log("hit:", JSON.stringify(hit));

const ps = await ctrl.pauseState(att.sessionId, hit.threadId);
console.log(`frames=${ps.frames.length} topLocals=${ps.locals.length}`);
console.log("top frame:", `${ps.frames[0].className}.${ps.frames[0].method}:${ps.frames[0].line}`);

console.log("sessions:", JSON.stringify(ctrl.listSessions()));
await ctrl.removeBreakpoint(att.sessionId, bp.id);
await ctrl.resume(att.sessionId);
await ctrl.detach(att.sessionId);
console.log("OK — unified controller validated live (Android).");
