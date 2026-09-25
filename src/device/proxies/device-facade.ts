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
  private activeTarget: Platform;

  constructor(
    private readonly adapters: Map<Platform, CorePlatformAdapter>,
    private readonly desktopFacade: DesktopFacade,
    initialTarget: Platform = "android",
  ) {
    this.activeTarget = initialTarget;
  }

  private requireAdapter(platform: Platform): CorePlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      const available = [...this.adapters.keys()].join(", ") || "none";
      throw new Error(
        `Platform '${platform}' is not installed. ` +
          `Enable it with \`mcp-devices install ${platform}\` ` +
          `(or set MCP_DEVICES_PLATFORMS=${platform}). ` +
          `Currently available: ${available}.`,
      );
    }
    return adapter;
  }

  setTarget(target: Platform): void {
    this.requireAdapter(target);
    this.activeTarget = target;
  }

  getCurrentPlatform(): Platform {
    return this.activeTarget;
  }

  getActiveDevice(): Device | undefined {
    if (this.activeTarget === "desktop") {
      return this.desktopFacade.isRunning() ? DESKTOP_DEVICE : undefined;
    }

    const adapter = this.adapters.get(this.activeTarget);
    const selectedId = adapter?.getSelectedDeviceId();
    if (!adapter || !selectedId) return undefined;

    return adapter.listDevices().find((device) => device.id === selectedId);
  }


  getTarget(): { target: Platform; status: string } {
    if (this.activeTarget === "desktop") {
      const state = this.desktopFacade.getState();
      if (state) return { target: "desktop", status: state.status };
      return { target: "desktop", status: "not available" };
    }
    const device = this.getActiveDevice();
    if (device) return { target: this.activeTarget, status: device.state };
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
      return this.requireAdapter(platform).listDevices();
    }
    return this.getAllDevices();
  }

  setDevice(deviceId: string, platform?: Platform): Device {
    if (platform && platform !== "desktop") this.requireAdapter(platform);
    if (platform === "desktop" || (deviceId === "desktop" && platform === undefined)) {
      if (deviceId !== "desktop") {
        throw new Error(`Device not found: ${deviceId}`);
      }
      if (!this.desktopFacade.isRunning()) {
        throw new Error("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      this.activeTarget = "desktop";
      return DESKTOP_DEVICE;
    }
    const listing = listAllDevices(this.adapters);
    const { device } = resolveDevice(deviceId, platform, listing);
    this.activeTarget = device.platform;
    this.adapters.get(device.platform)?.selectDevice(device.id);
    return device;
  }

  /** Keeps the target in sync after an adapter device is auto-selected. */
  recordAutoDetected(device: Device): void {
    this.activeTarget = device.platform;
  }
}
