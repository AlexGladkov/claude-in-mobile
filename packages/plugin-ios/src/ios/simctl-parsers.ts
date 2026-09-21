/**
 * Pure parsers for simctl JSON / text output. No I/O.
 */

import type { IosDevice } from "./types.js";
import { z } from "zod";


const simctlDeviceSchema = z.object({
  isAvailable: z.boolean().optional(),
  udid: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  name: z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/),
  state: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/),
}).passthrough();
const simctlRuntimeDevicesSchema = z.record(
  z.string().min(1).max(512),
  z.array(simctlDeviceSchema).max(1000),
).refine((devices) => Object.keys(devices).length <= 1000, "too many simulator runtimes");
const simctlDevicesSchema = z.object({
  devices: simctlRuntimeDevicesSchema,
}).passthrough();

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/**
 * Parse output of `xcrun simctl list devices -j` into a flat list of available
 * simulators. Unavailable devices are filtered out.
 */
export function parseDevicesJson(output: string): IosDevice[] {
  const data = simctlDevicesSchema.parse(JSON.parse(output));
  const devices: IosDevice[] = [];

  for (const [runtime, deviceList] of Object.entries(data.devices)) {


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
