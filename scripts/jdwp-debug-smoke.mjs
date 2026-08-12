// Live smoke of the full Android debug loop: attach -> breakpoint -> trigger ->
// poll (BREAKPOINT_HIT) -> pauseState (frames+locals) -> resume -> detach.
// Deterministic trigger: break on android.app.Activity.onResume, then send the
// app HOME and re-foreground it so onResume fires.
// Usage: node scripts/jdwp-debug-smoke.mjs <package> [activityBreakClass]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attachAndroid, resolvePid } from "../dist/debug/jdwp/session.js";
import { JdwpDebugger } from "../dist/debug/jdwp/debugger.js";

const pexec = promisify(execFile);
const pkg = process.argv[2] ?? "tech.mobiledeveloper.jethabit.debug";
const breakClass = process.argv[3] ?? "android.app.Activity";
const adb = async (args) => (await pexec("adb", args)).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = await resolvePid(adb, pkg);
const session = await attachAndroid({ pid, adb, localPort: 7801 });
const dbg = new JdwpDebugger(session);
console.log(`attached pid=${pid}`);

// Peek at the app's own classes (proof of class enumeration).
const appClasses = await dbg.allClasses("jethabit");
console.log(`app classes matching "jethabit": ${appClasses.length} (e.g. ${appClasses.slice(0, 3).map((c) => c.className).join(", ")})`);

// Set a method-entry breakpoint that a resume will hit.
const bp = await dbg.setMethodBreakpoint(breakClass, "onResume", true);
console.log(`breakpoint ${breakClass}.onResume ->`, bp);
if (!bp.verified) {
  console.log("class not loaded / method not found — cannot validate; detaching");
  await session.dispose();
  process.exit(1);
}

// Trigger: background then foreground the app so onResume fires.
// (monkey exits non-zero on the TV emulator but still launches — tolerate it.)
const tryAdb = async (args) => {
  try {
    await adb(args);
  } catch {
    /* ignore trigger exit codes */
  }
};
const activity = (await adb(["shell", "cmd", "package", "resolve-activity", "--brief", pkg]))
  .trim()
  .split(/\s+/)
  .pop();
await tryAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
await sleep(1000);
await tryAdb(["shell", "am", "start", "-n", activity]);
console.log(`triggered resume via am start -n ${activity}`);

// Poll for the hit.
let cursor = 0;
let hit = null;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const { events, nextCursor } = await dbg.poll(cursor);
  cursor = nextCursor;
  const bpHit = events.find((e) => e.kind === "BREAKPOINT_HIT");
  if (bpHit) {
    hit = bpHit;
    break;
  }
}

if (!hit) {
  console.log("no BREAKPOINT_HIT within timeout");
  await session.dispose();
  process.exit(1);
}
console.log("HIT:", JSON.stringify(hit));

// Inspect the paused thread.
const threadId = BigInt(hit.threadId);
const ps = await dbg.pauseState(threadId, 6);
console.log(`frames: ${ps.frames.length}`);
console.log(ps.frames.slice(0, 4).map((f) => `  #${f.index} ${f.className}.${f.method}${f.line ? ":" + f.line : ""}`).join("\n"));
console.log(`top-frame locals: ${ps.locals.length}`);
console.log(ps.locals.slice(0, 6).map((l) => `  ${l.type} ${l.name} = ${l.value}`).join("\n"));

// Resume and clean up.
await dbg.clearBreakpoint(bp.requestId);
await dbg.resume();
await session.dispose();
console.log("OK — full Android debug loop validated live.");
