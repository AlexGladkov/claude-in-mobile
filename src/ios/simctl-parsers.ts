/**
 * Pure parsers for simctl JSON / text output. No I/O.
 */

import type { IosDevice } from "./types.js";

interface RawDevice {
  isAvailable?: boolean;
  udid: string;
  name: string;
  state: string;
}

interface RawDevicesJson {
  devices: Record<string, RawDevice[]>;
}

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/**
 * Parse output of `xcrun simctl list devices -j` into a flat list of available
 * simulators. Unavailable devices are filtered out.
 */
export function parseDevicesJson(output: string): IosDevice[] {
  const data = JSON.parse(output) as RawDevicesJson;
  const devices: IosDevice[] = [];

  for (const [runtime, deviceList] of Object.entries(data.devices)) {
    if (!Array.isArray(deviceList)) continue;

    for (const device of deviceList) {
      if (device.isAvailable) {
        devices.push({
          id: device.udid,
          name: device.name,
          state: device.state.toLowerCase(),
          runtime: runtime.replace(RUNTIME_PREFIX, ""),
          isSimulator: true,
        });
      }
    }
  }

  return devices;
}
