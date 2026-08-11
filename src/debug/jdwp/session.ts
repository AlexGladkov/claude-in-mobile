/**
 * JdwpSession — high-level operations over a connected JdwpConnection.
 *
 * A session is created by attaching to a *debuggable* Android process: allocate
 * a local TCP port, `adb forward tcp:<port> jdwp:<pid>`, JDWP-handshake, then
 * negotiate ID sizes (required before any id-bearing command). The connection
 * is long-lived so breakpoints/suspends persist across agent calls.
 */

import { JdwpConnection } from "./connection.js";
import { JdwpReader, JdwpWriter, type IdSizes } from "./packet.js";
import { CommandSet, VirtualMachineCmd, ThreadReferenceCmd } from "./constants.js";

export interface VmVersion {
  description: string;
  jdwpMajor: number;
  jdwpMinor: number;
  vmVersion: string;
  vmName: string;
}

export interface ThreadInfo {
  id: string; // bigint rendered as decimal string for stable external ids
  name: string;
}

/** Runs an adb invocation, returning stdout. Injected so the session stays testable. */
export type AdbRunner = (args: string[]) => Promise<string>;

export class JdwpSession {
  constructor(
    private readonly conn: JdwpConnection,
    readonly idSizes: IdSizes,
    private readonly cleanup: () => void,
  ) {}

  get connected(): boolean {
    return this.conn.connected;
  }

  /** Low-level connection — used by the higher-level debugger surface. */
  get connection(): JdwpConnection {
    return this.conn;
  }

  onEvent(listener: (cmd: { data: Buffer }) => void): void {
    this.conn.on("event", listener);
  }

  onClose(listener: () => void): void {
    this.conn.on("close", listener);
  }

  async version(): Promise<VmVersion> {
    const data = await this.conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.Version);
    const r = new JdwpReader(data, this.idSizes);
    return {
      description: r.string(),
      jdwpMajor: r.int(),
      jdwpMinor: r.int(),
      vmVersion: r.string(),
      vmName: r.string(),
    };
  }

  async allThreadIds(): Promise<bigint[]> {
    const data = await this.conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.AllThreads);
    const r = new JdwpReader(data, this.idSizes);
    const count = r.int();
    const ids: bigint[] = [];
    for (let i = 0; i < count; i++) ids.push(r.threadID());
    return ids;
  }

  async threadName(id: bigint): Promise<string> {
    const w = new JdwpWriter(this.idSizes).threadID(id);
    const data = await this.conn.request(
      CommandSet.ThreadReference,
      ThreadReferenceCmd.Name,
      w.build(),
    );
    return new JdwpReader(data, this.idSizes).string();
  }

  /** Convenience: all threads with names (external ids as decimal strings). */
  async listThreads(): Promise<ThreadInfo[]> {
    const ids = await this.allThreadIds();
    const out: ThreadInfo[] = [];
    for (const id of ids) {
      let name = "<unknown>";
      try {
        name = await this.threadName(id);
      } catch {
        /* thread may have died mid-enumeration */
      }
      out.push({ id: id.toString(), name });
    }
    return out;
  }

  /** Suspend all threads in the VM. */
  async suspend(): Promise<void> {
    await this.conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.Suspend);
  }

  /** Resume all threads in the VM. */
  async resume(): Promise<void> {
    await this.conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.Resume);
  }

  /** Cleanly dispose the debug session (VM continues running) and drop the socket. */
  async dispose(): Promise<void> {
    try {
      await this.conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.Dispose);
    } catch {
      /* VM may already be gone */
    }
    this.close();
  }

  close(): void {
    this.conn.close();
    this.cleanup();
  }
}

/** Resolve a debuggable process id from a package name via `adb shell pidof`. */
export async function resolvePid(adb: AdbRunner, packageName: string): Promise<number> {
  const out = (await adb(["shell", "pidof", packageName])).trim();
  const pid = parseInt(out.split(/\s+/)[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`No running process for package ${packageName} (is it launched?)`);
  }
  return pid;
}

/**
 * Attach a JDWP debug session to a running, debuggable Android process.
 * Forwards a local port to the process's JDWP transport, handshakes, and
 * negotiates ID sizes.
 */
export async function attachAndroid(opts: {
  pid: number;
  adb: AdbRunner;
  localPort: number;
}): Promise<JdwpSession> {
  const { pid, adb, localPort } = opts;

  await adb(["forward", `tcp:${localPort}`, `jdwp:${pid}`]);
  const cleanup = () => {
    // Best-effort: release the adb forward. Fire-and-forget.
    void adb(["forward", "--remove", `tcp:${localPort}`]).catch(() => {});
  };

  const conn = new JdwpConnection();
  try {
    await conn.connect(localPort);
    const idSizes = await negotiateIdSizes(conn);
    return new JdwpSession(conn, idSizes, cleanup);
  } catch (e) {
    conn.close();
    cleanup();
    throw e;
  }
}

async function negotiateIdSizes(conn: JdwpConnection): Promise<IdSizes> {
  const data = await conn.request(CommandSet.VirtualMachine, VirtualMachineCmd.IDSizes);
  // IDSizes has no id fields, so a reader without sizes is fine here.
  const r = new JdwpReader(data);
  return {
    fieldIDSize: r.int(),
    methodIDSize: r.int(),
    objectIDSize: r.int(),
    referenceTypeIDSize: r.int(),
    frameIDSize: r.int(),
  };
}
