/**
 * DeviceFacade — owns device listing / selection / active-target
 * bookkeeping. Extracted from DeviceManager (D9.1c) to keep the
 * orchestrator under 400 LOC.
 *
 * Behaviour-preserving:
 *   - listAllDevices / resolveDevice still delegate to device-resolver.
 *   - Desktop is treated as a synthetic device id, mirroring legacy.
 *   - getTarget() merges desktop status with the regular device state.
 *
 * The facade keeps state (activeDevice, activeTarget) internally so the
 * DeviceManager just forwards calls — no duplicated mutable state.
 */

import type { CorePlatformAdapter } from "../../adapters/platform-adapter.js";
import type { Device, Platform } from "../../platform-types.js";
import { listAllDevices, resolveDevice } from "../device-resolver.js";
import type { DesktopFacade } from "./desktop-facade.js";

const DESKTOP_DEVICE: Device = {
  id: "desktop",
  name: "Desktop App",
  platform: "desktop",
  state: "running",
  isSimulator: false,
};

export class DeviceFacade {
  private activeDevice?: Device;
  private activeTarget: Platform;

  constructor(
    private readonly adapters: Map<Platform, CorePlatformAdapter>,
    private readonly desktopFacade: DesktopFacade,
    initialTarget: Platform = "android",
  ) {
    this.activeTarget = initialTarget;
  }

  setTarget(target: Platform): void {
    this.activeTarget = target;
  }

  getCurrentPlatform(): Platform {
    return this.activeTarget;
  }

  getActiveDevice(): Device | undefined {
    if (this.activeTarget === "desktop" && this.desktopFacade.isRunning()) {
      return DESKTOP_DEVICE;
    }
    return this.activeDevice;
  }

  getTarget(): { target: Platform; status: string } {
    if (this.activeTarget === "desktop") {
      const state = this.desktopFacade.getState();
      if (state) return { target: "desktop", status: state.status };
      return { target: "desktop", status: "not available" };
    }
    const device = this.activeDevice;
    if (device) return { target: device.platform, status: device.state };
    return { target: this.activeTarget, status: "no device" };
  }

  getAllDevicesWithErrors(): { devices: Device[]; errors: { platform: Platform; error: Error }[] } {
    return listAllDevices(this.adapters);
  }

  getAllDevices(): Device[] {
    return listAllDevices(this.adapters).devices;
  }

  getDevices(platform?: Platform): Device[] {
    if (platform) {
      const adapter = this.adapters.get(platform);
      return adapter ? adapter.listDevices() : [];
    }
    return this.getAllDevices();
  }

  setDevice(deviceId: string, platform?: Platform): Device {
    if (deviceId === "desktop" || platform === "desktop") {
      if (!this.desktopFacade.isRunning()) {
        throw new Error("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      this.activeTarget = "desktop";
      return DESKTOP_DEVICE;
    }
    const listing = listAllDevices(this.adapters);
    const { device } = resolveDevice(deviceId, platform, listing);
    this.activeDevice = device;
    this.activeTarget = device.platform;
    this.adapters.get(device.platform)?.selectDevice(device.id);
    return device;
  }

  /**
   * Used by DeviceManager.getAdapter() FIX #8 auto-detect path: when
   * the adapter discovers a device on its own, we sync facade state to
   * match the legacy single-source-of-truth behaviour.
   */
  recordAutoDetected(device: Device): void {
    this.activeDevice = device;
    this.activeTarget = device.platform;
  }
}
