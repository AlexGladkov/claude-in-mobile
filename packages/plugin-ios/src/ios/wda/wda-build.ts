import type { IosDevice } from "../types.js";

/**
 * The simulator WDA is about to launch on comes first, so the build never
 * addresses another, possibly busy, simulator. Otherwise booted first: building
 * against an already-running simulator skips a boot, and a particular model is
 * not guaranteed to exist on newer Xcodes.
 */
export function pickBuildSimulator(devices: IosDevice[], preferredId?: string): IosDevice | undefined {
  const preferred = devices.find((device) => device.id === preferredId && device.runtime.startsWith("iOS"));
  if (preferred) return preferred;
  const usable = devices.filter((device) => /^(iPhone|iPad)/.test(device.name));
  return usable.find((device) => device.state === "booted") ?? usable[0];
}
