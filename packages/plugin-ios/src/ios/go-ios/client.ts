/**
 * go-ios (`ios`) invocation for physical iOS device discovery.
 *
 * Mirrors the simctl-exec pattern: argv-form execFileSync, never /bin/sh.
 * Discovery (`ios list` / `ios info`) works over usbmux WITHOUT the iOS 17+
 * RemoteXPC tunnel — the tunnel is only needed later for WDA port forwarding.
 *
 * Every call is best-effort: if the `ios` binary is absent (go-ios not
 * installed) or errors, discovery returns an empty list so simulator-only
 * setups are unaffected.
 */

import { execFileSync } from "child_process";

import type { IosDevice } from "../types.js";
import { parseDeviceList, parseInfo, toIosDevice } from "./parsers.js";

export const GO_IOS_BIN = process.env.GO_IOS_BIN ?? "ios";
export const GO_IOS_TIMEOUT_MS = 10_000;

/** Run `ios <args>`, returning stdout, or null if the binary is missing/fails. */
function runIos(args: string[]): string | null {
  try {
    return execFileSync(GO_IOS_BIN, args, {
      encoding: "utf-8",
      timeout: GO_IOS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // go-ios writes structured logs to stderr; keep stdout clean for parsing.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** True if the go-ios binary is invokable. */
export function isGoIosAvailable(): boolean {
  return runIos(["version"]) !== null;
}

/**
 * Enumerate connected physical iOS devices via go-ios. Returns [] when go-ios
 * is unavailable or no device is attached. Per-device `ios info` failures are
 * tolerated — the device is still returned with its udid and sensible defaults.
 */
export function listPhysicalDevices(): IosDevice[] {
  const listOut = runIos(["list"]);
  if (listOut === null) return [];

  const udids = parseDeviceList(listOut);
  return udids.map((udid) => {
    const infoOut = runIos(["info", "--udid", udid]);
    const info = infoOut ? parseInfo(infoOut) : {};
    return toIosDevice(udid, info);
  });
}
