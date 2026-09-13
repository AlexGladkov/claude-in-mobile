import { execFile, spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import type {
  PerformanceTraceCapture,
  PerformanceTraceHandle,
  PerformanceTracePreset,
} from "mcp-devices/adapters/platform-adapter";
import { MobileError } from "mcp-devices/errors";
import { readPrivateFile } from "mcp-devices/utils/private-storage";

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 15_000;
export const XCTRACE_FINALIZE_TIMEOUT_MS = 45_000;
export const XCTRACE_COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;
const MAX_TRACE_SIZE = 32 * 1024 * 1024;

export interface XctraceStartOptions {
  deviceId: string;
  bundleId: string;
  session?: string;
  pid: number;
  preset: PerformanceTracePreset;
  durationMs: number;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface XctraceToc {
  schemas: string[];
  templateName?: string;
  instrumentsVersion?: string;
}

export class XctraceRecording {
  readonly handle: PerformanceTraceHandle;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly rootDir: string;
  private readonly tracePath: string;
  private readonly exitPromise: Promise<ProcessResult>;
  private readonly templateWarning?: string;
  private output = "";

  private constructor(options: XctraceStartOptions, rootDir: string) {
    const traceId = randomUUID();
    const startedAtMs = Date.now();
    this.handle = {
      traceId,
      platform: "ios",
      preset: options.preset,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + options.durationMs).toISOString(),
    };
    this.rootDir = rootDir;
    this.tracePath = join(rootDir, `${traceId}.trace`);
    // The iOS adapter targets Simulator runtimes. xctrace advertises
    // Animation Hitches there but exits with "not supported" and leaves an
    // empty-looking archive, so retain a useful bounded capture instead.
    const template = "Time Profiler";
    if (options.preset === "ui-jank") {
      this.templateWarning = "Animation Hitches is unavailable on Simulator; captured Time Profiler instead.";
    }
    this.process = spawn("xcrun", [
      "xctrace",
      "record",
      "--template",
      template,
      "--device",
      options.deviceId,
      "--time-limit",
      `${options.durationMs}ms`,
      "--output",
      this.tracePath,
      "--attach",
      String(options.pid),
      "--no-prompt",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: xctraceEnvironment(),
    });
    this.process.stdin.end();
    const appendOutput = (chunk: Buffer) => {
      if (this.output.length >= XCTRACE_COMMAND_OUTPUT_LIMIT) return;
      this.output += chunk.toString("utf8", 0, XCTRACE_COMMAND_OUTPUT_LIMIT - this.output.length);
    };
    this.process.stdout.on("data", appendOutput);
    this.process.stderr.on("data", appendOutput);
    this.exitPromise = new Promise((resolve, reject) => {
      this.process.once("error", reject);
      this.process.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  static async start(options: XctraceStartOptions): Promise<XctraceRecording> {
    const rootDir = await mkdtemp(join(tmpdir(), "mcp-devices-xctrace-"));
    const recording = new XctraceRecording(options, rootDir);
    try {
      await recording.waitUntilStarted();
      return recording;
    } catch (error) {
      await recording.discard();
      throw error;
    }
  }

  async finish(options: XctraceStartOptions): Promise<PerformanceTraceCapture> {
    try {
      if (this.process.exitCode === null && this.process.signalCode === null) {
        this.process.kill("SIGINT");
      }
      const result = await withTimeout(this.exitPromise, XCTRACE_FINALIZE_TIMEOUT_MS, "xctrace did not finish saving the trace.");
      const trace = await stat(this.tracePath).catch(() => null);
      if (!trace || !trace.isDirectory()) {
        throw this.failure(`xctrace exited before producing a trace (exit ${result.code ?? result.signal ?? "unknown"}).`);
      }

      const toc = await this.exportToc();
      const zipPath = `${this.tracePath}.zip`;
      await execFileAsync("/usr/bin/ditto", [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        this.tracePath,
        zipPath,
      ], {
        timeout: XCTRACE_FINALIZE_TIMEOUT_MS,
        maxBuffer: XCTRACE_COMMAND_OUTPUT_LIMIT,
        env: xctraceEnvironment(),
      });
      const data = await readPrivateFile(zipPath, MAX_TRACE_SIZE, "xctrace artifact");
      if (data.length === 0) {
        throw new MobileError("xctrace artifact is empty.", "PERF_TRACE_TOO_LARGE");
      }
      const endedAt = new Date().toISOString();
      return {
        ...this.handle,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(this.handle.startedAt)),
        format: "xctrace-zip",
        mimeType: "application/zip",
        producer: `Apple Instruments xctrace${toc.instrumentsVersion ? ` ${toc.instrumentsVersion}` : ""}`,
        summary: {
          instrumentCount: toc.schemas.length,
          analysisTool: toc.templateName ? `xctrace ${toc.templateName}` : "xctrace",
          warnings: [
            ...(this.templateWarning ? [this.templateWarning] : []),
            ...(toc.schemas.length === 0 ? ["xctrace TOC contained no instrument data tables."] : []),
          ],
        },
        data,
        session: options.session ?? options.bundleId,
      };
    } finally {
      await this.terminate();
      await rm(this.rootDir, { recursive: true, force: true });
    }
  }

  async discard(): Promise<void> {
    await this.terminate();
    await rm(this.rootDir, { recursive: true, force: true });
  }

  private async terminate(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.kill("SIGINT");
    await Promise.race([
      this.exitPromise.catch(() => ({ code: null, signal: null })),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGKILL");
      await Promise.race([
        this.exitPromise.catch(() => ({ code: null, signal: null })),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }

  private async waitUntilStarted(): Promise<void> {
    const started = new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (this.output.includes("Starting recording")) resolve();
      };
      this.process.stdout.on("data", inspect);
      this.process.stderr.on("data", inspect);
      this.exitPromise.then((result) => {
        reject(this.failure(`xctrace exited before recording started (exit ${result.code ?? result.signal ?? "unknown"}).`));
      }, reject);
    });
    await withTimeout(started, START_TIMEOUT_MS, "xctrace did not report that recording started.");
  }

  private async exportToc(): Promise<XctraceToc> {
    try {
      const { stdout } = await execFileAsync("xcrun", [
        "xctrace",
        "export",
        "--input",
        this.tracePath,
        "--toc",
      ], {
        encoding: "utf8",
        timeout: XCTRACE_FINALIZE_TIMEOUT_MS,
        maxBuffer: XCTRACE_COMMAND_OUTPUT_LIMIT,
        env: xctraceEnvironment(),
      });
      return parseXctraceToc(stdout);
    } catch {
      return { schemas: [] };
    }
  }

  private failure(message: string): MobileError {
    return new MobileError(message, "IOS_XCTRACE_FAILED");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MobileError(message, "IOS_XCTRACE_TIMEOUT")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseXctraceToc(xml: string): XctraceToc {
  const schemas = [...xml.matchAll(/<table\b[^>]*\bschema="([^"]+)"/g)].map((match) => match[1]);
  return {
    schemas: [...new Set(schemas)],
    templateName: xml.match(/<template-name>([^<]+)<\/template-name>/)?.[1],
    instrumentsVersion: xml.match(/<instruments-version>([^<]+)<\/instruments-version>/)?.[1],
  };
}

export function xctraceEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
