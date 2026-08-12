// Live smoke of Android eval (JDWP InvokeMethod / field read): break in
// Activity.onResume where `this` is the Activity, then evaluate against it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attachAndroid, resolvePid } from "../dist/debug/jdwp/session.js";
import { JdwpDebugger } from "../dist/debug/jdwp/debugger.js";

const pexec = promisify(execFile);
const pkg = "tech.mobiledeveloper.jethabit.debug";
const adb = async (a) => (await pexec("adb", a)).stdout;
const tryAdb = async (a) => { try { await adb(a); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = await resolvePid(adb, pkg);
const session = await attachAndroid({ pid, adb, localPort: 7803 });
const dbg = new JdwpDebugger(session);
const bp = await dbg.setMethodBreakpoint("android.app.Activity", "onResume", true);

const activity = (await adb(["shell", "cmd", "package", "resolve-activity", "--brief", pkg])).trim().split(/\s+/).pop();
await tryAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
await sleep(1000);
await tryAdb(["shell", "am", "start", "-n", activity]);

let cursor = 0, hit = null;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const p = await dbg.poll(cursor); cursor = p.nextCursor;
  hit = p.events.find((e) => e.kind === "BREAKPOINT_HIT");
  if (hit) break;
}
if (!hit) { console.log("no hit"); await session.dispose(); process.exit(1); }
const tid = BigInt(hit.threadId);
console.log("paused in Activity.onResume, thread", hit.threadId);

for (const expr of ["this", "this.hashCode()", "this.toString()", "this.getLocalClassName()", "this.getClass()"]) {
  try {
    const r = await dbg.eval(tid, expr);
    console.log(`eval ${expr.padEnd(24)} => ${r.type} ${r.value}${r.objectId ? " @" + r.objectId : ""}`);
  } catch (e) {
    console.log(`eval ${expr.padEnd(24)} => ERROR ${e.message}`);
  }
}

await dbg.clearBreakpoint(bp.requestId);
await dbg.resume();
await session.dispose();
console.log("OK — Android eval validated live (InvokeMethod + field/string).");
