// Throwaway live smoke: attach the native JDWP client to a debuggable Android
// app and exercise the foundation (version, id sizes, threads, suspend/resume).
// Usage: node scripts/jdwp-smoke.mjs <package> [localPort]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attachAndroid, resolvePid } from "../dist/debug/jdwp/session.js";

const pexec = promisify(execFile);
const pkg = process.argv[2] ?? "tech.mobiledeveloper.jethabit.debug";
const port = parseInt(process.argv[3] ?? "7799", 10);
const adb = async (args) => (await pexec("adb", args)).stdout;

const pid = await resolvePid(adb, pkg);
console.log(`pid(${pkg}) = ${pid}`);

const session = await attachAndroid({ pid, adb, localPort: port });
console.log("idSizes:", session.idSizes);

const v = await session.version();
console.log("VM:", v.vmName, v.vmVersion, "| JDWP", `${v.jdwpMajor}.${v.jdwpMinor}`);

const threads = await session.listThreads();
console.log(`threads: ${threads.length}`);
console.log(threads.slice(0, 8).map((t) => `  #${t.id} ${t.name}`).join("\n"));

console.log("suspend…");
await session.suspend();
console.log("resume…");
await session.resume();

await session.dispose();
console.log("OK — foundation validated live.");
