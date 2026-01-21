# Aurora OS Support Design for Claude-in-Mobile

**Date:** 2026-01-21
**Status:** Design Approved
**Author:** Claude + User

## Overview

Add Aurora OS platform support to `claude-in-mobile` MCP server using `audb` CLI tool as the interface.

## Architecture

### Approach: Direct CLI Calls

`audb CLI` manages its own server and SSH connection pool. We call `audb` commands directly:

```
MCP Server → exec("audb tap 360 720") → audb CLI → audb-server → SSH → Device
```

**Pros:**
- Simple implementation
- audb handles server auto-start
- No need to understand audb-server protocol

**Cons:**
- Process spawn overhead (~1-5ms, negligible)

### Project Structure

```
src/
├── aurora/              # New directory
│   ├── client.ts        # AuroraClient class
│   └── index.ts         # Export
├── device-manager.ts    # Update: add "aurora" to Platform
└── index.ts             # Update: platform enum, tool handlers
```

## AuroraClient Interface

```typescript
class AuroraClient {
  // Device management
  listDevices(): Promise<Device[]>
  getActiveDevice(): string

  // Screenshots & UI
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>
  tap(x: number, y: number): Promise<void>
  longPress(x: number, y: number, duration: number): Promise<void>
  swipeDirection(direction: string): Promise<void>
  swipeCoords(x1, y1, x2, y2): Promise<void>

  // Keys
  pressKey(key: string): Promise<void>

  // Apps
  launchApp(package: string): Promise<string>
  stopApp(package: string): Promise<void>
  installApp(path: string): Promise<string>
  uninstallApp(package: string): Promise<string>

  // System
  shell(command: string): Promise<string>
  getLogs(options): Promise<string>
  clearLogs(): Promise<string>
  getSystemInfo(): Promise<string>

  // Files (new to MCP)
  pushFile(local: string, remote: string): Promise<string>
  pullFile(remote: string, local?: string): Promise<Buffer>
}
```

## Implementation Pattern

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

class AuroraClient {
  private async runCommand(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(command);
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`audb failed: ${error.message}`);
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.runCommand(`audb tap ${x} ${y}`);
  }

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const tmpFile = `/tmp/aurora_screenshot_${Date.now()}.png`;
    await this.runCommand(`audb screenshot --output ${tmpFile}`);
    const buffer = await fs.readFile(tmpFile);
    await fs.unlink(tmpFile);
    return this.compressImage(buffer, options);
  }
}
```

## DeviceManager Integration

```typescript
type Platform = "android" | "ios" | "desktop" | "aurora";

class DeviceManager {
  private auroraClient: AuroraClient;

  private getClient(platform: Platform) {
    switch (platform) {
      case "android": return this.androidClient;
      case "ios": return this.iosClient;
      case "desktop": return this.desktopClient;
      case "aurora": return this.auroraClient;
    }
  }

  async tap(x: number, y: number, platform?: Platform): Promise<void> {
    const p = platform ?? this.getCurrentPlatform();
    await this.getClient(p).tap(x, y);
  }
}
```

## MCP Tools

### Updated platform parameter
```typescript
const platformParam = {
  type: "string",
  enum: ["android", "ios", "desktop", "aurora"],
  description: "Target platform",
};
```

### New Aurora-only tools

| Tool | audb command | Description |
|------|--------------|-------------|
| `push_file` | `audb push local remote` | Upload file to device |
| `pull_file` | `audb pull remote [local]` | Download file from device |

### Supported tools (18 total)

Basic: `list_devices`, `set_device`, `screenshot`, `tap`, `long_press`, `swipe`, `press_key`, `wait`

Apps: `launch_app`, `stop_app`, `install_app`, `uninstall_app`

System: `shell`, `get_logs`, `clear_logs`, `get_system_info`

Files: `push_file`, `pull_file`

### NOT supported (no UI hierarchy in Aurora OS)

- `get_ui` — no `uiautomator` equivalent
- `find_element` — depends on get_ui
- `analyze_screen` — depends on get_ui
- `find_and_tap` — depends on get_ui
- `input_text` — TODO: research DBus/clipboard workaround

## Configuration Files

audb stores config in:
```
~/.config/audb/
├── current_device      # Selected device (IP or name)
├── devices.json        # All devices list
└── server.pid          # Server PID if running

~/.cache/audb/          # Signing keys cache
```

User pre-selects device with `audb select <device>` or we use `-d <device>` flag.

## Error Handling

| Error | Cause | Solution message |
|-------|-------|------------------|
| `No device selected` | Device not selected | `audb device list` + `audb select` |
| `Device disconnected` | SSH disconnect | Auto-reconnect or `audb reconnect` |
| `Python not found` | No python3 on device | `devel-su pkcon install python3` |
| `Permission denied` | No root password | `audb device add` again |
| `audb: command not found` | audb not installed | `cargo install audb-client` |

```typescript
private async runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command);
    if (stderr?.includes("No device selected")) {
      throw new Error("No Aurora device selected. Run:\n  1. audb device list\n  2. audb select <device>");
    }
    return stdout.trim();
  } catch (error: any) {
    if (error.message.includes("audb: command not found")) {
      throw new Error("audb not found. Install: cargo install audb-client");
    }
    throw error;
  }
}
```

## Availability Check

```typescript
async checkAvailability(): Promise<boolean> {
  try {
    await execAsync("audb --version");
    return true;
  } catch {
    return false;
  }
}
```

If unavailable, Aurora devices shown as unavailable in `list_devices` with install hint.

## TODO (Future)

- `input_text` — research DBus API or clipboard workaround for text input
- Direct socket communication with audb-server (performance optimization)
