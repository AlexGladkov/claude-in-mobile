import { execFile } from "child_process";
import { chmod, mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import type { HeapSnapshotCapture } from "mcp-devices/adapters/platform-adapter";
import { MobileError } from "mcp-devices/errors";

import {
  parseXctraceToc,
  XCTRACE_COMMAND_OUTPUT_LIMIT,
  XCTRACE_FINALIZE_TIMEOUT_MS,
  xctraceEnvironment,
} from "./xctrace.js";

const execFileAsync = promisify(execFile);
const CAPTURE_DURATION = "1s";

export interface IosHeapCaptureOptions {
  deviceId: string;
  bundleId: string;
  pid: number;
  outputPath: string;
  session?: string;
}

export async function captureIosHeapSnapshot(
  options: IosHeapCaptureOptions,
): Promise<HeapSnapshotCapture> {
  const rootDir = await mkdtemp(join(tmpdir(), "mcp-devices-ios-heap-"));
  const tracePath = join(rootDir, "allocations.trace");
  try {
    await execFileAsync("xcrun", [
      "xctrace",
      "record",
      "--template",
      "Allocations",
      "--device",
      options.deviceId,
      "--time-limit",
      CAPTURE_DURATION,
      "--output",
      tracePath,
      "--attach",
      String(options.pid),
      "--no-prompt",
    ], {
      timeout: XCTRACE_FINALIZE_TIMEOUT_MS,
      maxBuffer: XCTRACE_COMMAND_OUTPUT_LIMIT,
      env: xctraceEnvironment(),
    });

    const trace = await stat(tracePath).catch(() => null);
    if (!trace?.isDirectory()) {
      throw new MobileError("xctrace did not produce an Allocations trace bundle.", "IOS_HEAP_CAPTURE_FAILED");
    }

    const { stdout: tocXml } = await execFileAsync("xcrun", [
      "xctrace",
      "export",
      "--input",
      tracePath,
      "--toc",
    ], {
      encoding: "utf8",
      timeout: XCTRACE_FINALIZE_TIMEOUT_MS,
      maxBuffer: XCTRACE_COMMAND_OUTPUT_LIMIT,
      env: xctraceEnvironment(),
    });
    const toc = parseXctraceToc(tocXml);
    if (toc.templateName !== "Allocations") {
      throw new MobileError("xctrace returned a non-Allocations trace bundle.", "IOS_HEAP_CAPTURE_FAILED");
    }

    await execFileAsync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      tracePath,
      options.outputPath,
    ], {
      timeout: XCTRACE_FINALIZE_TIMEOUT_MS,
      maxBuffer: XCTRACE_COMMAND_OUTPUT_LIMIT,
      env: xctraceEnvironment(),
    });
    await chmod(options.outputPath, 0o600);
    const output = await stat(options.outputPath);
    return {
      platform: "ios",
      capturedAt: new Date().toISOString(),
      format: "xctrace-allocations",
      mimeType: "application/zip",
      producer: `Apple Instruments xctrace${toc.instrumentsVersion ? ` ${toc.instrumentsVersion}` : ""}`,
      session: options.session ?? options.bundleId,
      summary: {
        sizeBytes: output.size,
        instrumentCount: toc.schemas.length,
        warnings: toc.schemas.length === 0
          ? ["xctrace Allocations TOC contained no instrument data tables."]
          : [],
      },
    };
  } catch (error: unknown) {
    if (error instanceof MobileError) throw error;
    throw new MobileError("iOS Allocations capture failed.", "IOS_HEAP_CAPTURE_FAILED");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}
