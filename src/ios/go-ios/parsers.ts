/**
 * Pure parsers for go-ios (`ios`) JSON output. No I/O.
 *
 * go-ios emits newline-delimited JSON: structured log lines (level/msg/time)
 * interleaved with the actual result object. These parsers scan every line and
 * pick the one carrying the expected result key, so log noise (e.g. the
 * "agent is not running" WARN on iOS 17+) never corrupts the result.
 */

import type { IosDevice } from "../types.js";

/** Parse each line as JSON, ignoring blanks and non-JSON noise. */
function parseJsonLines(output: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      // structured-log line that isn't valid standalone JSON — skip
    }
  }
  return out;
}

/**
 * Parse `ios list` output into a list of physical-device UDIDs. The result line
 * looks like `{"deviceList":["00008130-..."]}`; log lines are skipped.
 */
export function parseDeviceList(output: string): string[] {
  for (const obj of parseJsonLines(output)) {
    const list = obj.deviceList;
    if (Array.isArray(list)) {
      return list.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

export interface GoIosInfo {
  name?: string;
  productVersion?: string;
  productType?: string;
  deviceClass?: string;
}

/**
 * Parse `ios info` output. The result object is the one carrying device
 * identity keys (UniqueDeviceID / ProductVersion); log lines are skipped.
 */
export function parseInfo(output: string): GoIosInfo {
  for (const obj of parseJsonLines(output)) {
    if ("ProductVersion" in obj || "UniqueDeviceID" in obj) {
      return {
        name: strOrUndef(obj.DeviceName),
        productVersion: strOrUndef(obj.ProductVersion),
        productType: strOrUndef(obj.ProductType),
        deviceClass: strOrUndef(obj.DeviceClass),
      };
    }
  }
  return {};
}

/** Build an `IosDevice` for a physical device from its udid + (optional) info. */
export function toIosDevice(udid: string, info: GoIosInfo): IosDevice {
  return {
    id: udid,
    name: info.name ?? info.productType ?? info.deviceClass ?? "iOS device",
    // Physical devices report "connected"; autoDetectDevice already matches it.
    state: "connected",
    runtime: info.productVersion ? `iOS ${info.productVersion}` : "iOS",
    isSimulator: false,
  };
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
