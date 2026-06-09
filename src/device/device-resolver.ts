/**
 * DeviceResolver -- device lookup, listing aggregation, and selection.
 *
 * Extracted from device-manager.ts (D9.1). Owns:
 *   - Aggregating `listDevices()` across all adapters with per-platform error
 *     capture (so callers can surface ADB_NOT_INSTALLED vs an empty list).
 *   - Resolving a `deviceId` (and optional platform hint) to a concrete Device.
 *   - Propagating selection to the matching adapter.
 *
 * Behaviour-preserving: pure function set, no hidden state. The facade
 * (DeviceManager) still owns `activeDevice` / `activeTarget` mutable state
 * and calls back into these helpers.
 */

import type { CorePlatformAdapter } from "../adapters/platform-adapter.js";
import type { Device, Platform } from "../platform-types.js";

export interface DevicesWithErrors {
  devices: Device[];
  errors: { platform: Platform; error: Error }[];
}

/**
 * Walk every adapter's `listDevices()` and aggregate. Captures structural
 * errors per-platform rather than letting one bad adapter throw the whole
 * listing.
 */
export function listAllDevices(
  adapters: Map<Platform, CorePlatformAdapter>,
): DevicesWithErrors {
  const devices: Device[] = [];
  const errors: { platform: Platform; error: Error }[] = [];
  for (const [platform, adapter] of adapters.entries()) {
    try {
      devices.push(...adapter.listDevices());
    } catch (e) {
      errors.push({ platform, error: e instanceof Error ? e : new Error(String(e)) });
    }
  }
  return { devices, errors };
}

/**
 * Result of resolving a deviceId to a Device. Either contains the device
 * (with adapter side-effect already applied) or throws.
 */
export interface ResolvedDevice {
  device: Device;
}

/**
 * Resolve a deviceId (with optional platform hint) to a Device.
 *
 * Match strategy (preserves legacy ordering):
 *   1. Exact id match across all platforms.
 *   2. If a platform hint is given and (1) failed, pick any booted device
 *      on that platform (state ∈ {device, booted, connected}).
 *   3. If nothing matched and the relevant adapter errored structurally,
 *      surface that error -- "Device not found" is misleading when the
 *      toolchain itself failed.
 *
 * Does NOT mutate the adapter; caller is responsible for `selectDevice`
 * after picking a target (matches legacy flow which did so inline).
 */
export function resolveDevice(
  deviceId: string,
  platform: Platform | undefined,
  listing: DevicesWithErrors,
): ResolvedDevice {
  const { devices, errors } = listing;

  let device = devices.find((d) => d.id === deviceId);

  if (!device && platform) {
    device = devices.find(
      (d) =>
        d.platform === platform &&
        (d.state === "device" || d.state === "booted" || d.state === "connected"),
    );
  }

  if (!device) {
    const relevant = platform
      ? errors.find((e) => e.platform === platform)
      : errors[0];
    if (relevant) throw relevant.error;
    throw new Error(`Device not found: ${deviceId}`);
  }

  return { device };
}
