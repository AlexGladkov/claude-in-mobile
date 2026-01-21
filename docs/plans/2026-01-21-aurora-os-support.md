# Aurora OS Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Aurora OS platform support to claude-in-mobile MCP server using audb CLI

**Architecture:** Create AuroraClient wrapper around audb CLI, integrate with DeviceManager, add 18 MCP tools

**Tech Stack:** TypeScript, Node.js, audb CLI (Rust), MCP SDK

---

## Prerequisites

1. Install audb: `cargo install audb-client audb-server`
2. Add Aurora device: `audb device add`
3. Select device: `audb select <device>`

---

## Task 1: Create AuroraClient Base Structure

**Files:**
- Create: `src/aurora/client.ts`
- Create: `src/aurora/index.ts`

**Step 1: Create AuroraClient class with base structure**

```typescript
// src/aurora/client.ts
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";

const execAsync = promisify(exec);

export interface ScreenshotOptions {
  compress?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface ScreenshotResult {
  data: string;
  mimeType: string;
}

export interface Device {
  id: string;
  name: string;
  platform: "aurora";
  state: "connected" | "disconnected";
  host: string;
}

export class AuroraClient {
  private async runCommand(command: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr?.includes("No device selected")) {
        throw new Error(
          "No Aurora device selected. Run:\n" +
          "  1. audb device list\n" +
          "  2. audb select <device>"
        );
      }
      return stdout.trim();
    } catch (error: any) {
      if (error.message.includes("audb: command not found")) {
        throw new Error("audb not found. Install: cargo install audb-client");
      }
      throw new Error(`audb failed: ${error.message}`);
    }
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("audb --version");
      return true;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<Device[]> {
    // TODO: parse audb device list output
    return [];
  }

  async getActiveDevice(): string {
    try {
      const path = `${process.env.HOME}/.config/audb/current_device`;
      return await fs.readFile(path, "utf-8");
    } catch {
      throw new Error("No device selected");
    }
  }
}
```

**Step 2: Create index.ts export**

```typescript
// src/aurora/index.ts
export { AuroraClient, Device, ScreenshotOptions, ScreenshotResult } from "./client.js";

export const auroraClient = new AuroraClient();
```

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/aurora/
git commit -m "feat: add AuroraClient base structure"
```

---

## Task 2: Implement UI Interaction Methods

**Files:**
- Modify: `src/aurora/client.ts`

**Step 1: Add tap, longPress, swipe, pressKey methods**

```typescript
// Add to AuroraClient class

async tap(x: number, y: number): Promise<void> {
  await this.runCommand(`audb tap ${x} ${y}`);
}

async longPress(x: number, y: number, duration: number): Promise<void> {
  await this.runCommand(`audb tap ${x} ${y} --duration ${duration}`);
}

async swipeDirection(direction: "up"|"down"|"left"|"right"): Promise<void> {
  await this.runCommand(`audb swipe ${direction}`);
}

async swipeCoords(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await this.runCommand(`audb swipe ${x1} ${y1} ${x2} ${y2}`);
}

async pressKey(key: string): Promise<void> {
  await this.runCommand(`audb key ${key}`);
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aurora/client.ts
git commit -m "feat: add UI interaction methods to AuroraClient"
```

---

## Task 3: Implement Screenshot Method

**Files:**
- Modify: `src/aurora/client.ts`
- Modify: `src/utils/image.ts` (create if not exists)

**Step 1: Create image compression utility**

```typescript
// src/utils/image.ts
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ImageResult {
  data: string;
  mimeType: string;
}

export async function compressScreenshot(
  buffer: Buffer,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {}
): Promise<ImageResult> {
  const { maxWidth = 800, maxHeight = 1400, quality = 70 } = options;

  const tmpInput = `/tmp/screenshot_${Date.now()}_in.png`;
  const tmpOutput = `/tmp/screenshot_${Date.now()}_out.jpg`;

  await fs.writeFile(tmpInput, buffer);

  try {
    await execAsync(
      `ffmpeg -i ${tmpInput} -vf "scale='min(${maxWidth},iw):min(${maxHeight},ih)'" ` +
      `-q:v ${quality} ${tmpOutput}`
    );

    const compressed = await fs.readFile(tmpOutput);
    await fs.unlink(tmpInput);
    await fs.unlink(tmpOutput);

    return {
      data: compressed.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch {
    // Fallback: return original as PNG
    await fs.unlink(tmpInput);
    return {
      data: buffer.toString("base64"),
      mimeType: "image/png",
    };
  }
}
```

**Step 2: Add screenshot method to AuroraClient**

```typescript
// Add to AuroraClient class
import { compressScreenshot } from "../utils/image.js";

async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const tmpFile = `/tmp/aurora_screenshot_${Date.now()}.png`;
  await this.runCommand(`audb screenshot --output ${tmpFile}`);

  const buffer = await fs.readFile(tmpFile);
  await fs.unlink(tmpFile);

  if (options.compress !== false) {
    return compressScreenshot(buffer, {
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      quality: options.quality,
    });
  }

  return {
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
}
```

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/aurora/client.ts src/utils/image.ts
git commit -m "feat: add screenshot support with compression"
```

---

## Task 4: Implement App Management Methods

**Files:**
- Modify: `src/aurora/client.ts`

**Step 1: Add launchApp, stopApp, installApp, uninstallApp**

```typescript
// Add to AuroraClient class

async launchApp(package: string): Promise<string> {
  const output = await this.runCommand(`audb launch ${package}`);
  return output || `Launched ${package}`;
}

async stopApp(package: string): Promise<void> {
  await this.runCommand(`audb stop ${package}`);
}

async installApp(path: string): Promise<string> {
  const output = await this.runCommand(`audb package install ${path}`);
  return output || `Installed ${path}`;
}

async uninstallApp(package: string): Promise<string> {
  const output = await this.runCommand(`audb package uninstall ${package}`);
  return output || `Uninstalled ${package}`;
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aurora/client.ts
git commit -m "feat: add app management methods"
```

---

## Task 5: Implement System Methods

**Files:**
- Modify: `src/aurora/client.ts`

**Step 1: Add shell, getLogs, clearLogs, getSystemInfo**

```typescript
// Add to AuroraClient class

async shell(command: string): Promise<string> {
  const output = await this.runCommand(`audb shell ${command}`);
  return output;
}

async getLogs(options: {
  lines?: number;
  priority?: string;
  unit?: string;
  grep?: string;
  since?: string;
} = {}): Promise<string> {
  let cmd = "audb logs";
  if (options.lines) cmd += ` -n ${options.lines}`;
  if (options.priority) cmd += ` --priority ${options.priority}`;
  if (options.unit) cmd += ` --unit ${options.unit}`;
  if (options.grep) cmd += ` --grep '${options.grep}'`;
  if (options.since) cmd += ` --since '${options.since}'`;

  return await this.runCommand(cmd);
}

async clearLogs(): Promise<string> {
  return await this.runCommand("audb logs --clear --force");
}

async getSystemInfo(): Promise<string> {
  return await this.runCommand("audb info");
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aurora/client.ts
git commit -m "feat: add system methods (shell, logs, info)"
```

---

## Task 6: Implement File Transfer Methods

**Files:**
- Modify: `src/aurora/client.ts`

**Step 1: Add pushFile, pullFile**

```typescript
// Add to AuroraClient class

async pushFile(localPath: string, remotePath: string): Promise<string> {
  const output = await this.runCommand(`audb push ${localPath} ${remotePath}`);
  return output || `Uploaded ${localPath} → ${remotePath}`;
}

async pullFile(remotePath: string, localPath?: string): Promise<Buffer> {
  const local = localPath || remotePath.split("/").pop() || "pulled_file";
  await this.runCommand(`audb pull ${remotePath} --output ${local}`);
  return await fs.readFile(local);
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aurora/client.ts
git commit -m "feat: add file transfer methods (push/pull)"
```

---

## Task 7: Implement listDevices with Real Parsing

**Files:**
- Modify: `src/aurora/client.ts`

**Step 1: Replace listDevices with actual implementation**

```typescript
// Replace listDevices in AuroraClient class

async listDevices(): Promise<Device[]> {
  try {
    const output = await this.runCommand("audb device list");
    const devices: Device[] = [];

    // Parse audb output format:
    // • 192.168.2.15 - My Device (aurora-arm64, connected)
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/•\s+([\d.]+)\s+-\s+(.+?)\s+\((.+?),\s+(\w+)\)/);
      if (match) {
        const [, host, name, , state] = match;
        devices.push({
          id: host,
          name: name.trim(),
          platform: "aurora",
          state: state === "connected" ? "connected" : "disconnected",
          host,
        });
      }
    }

    return devices;
  } catch (error) {
    return [];
  }
}
```

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aurora/client.ts
git commit -m "feat: parse device list from audb output"
```

---

## Task 8: Update DeviceManager

**Files:**
- Modify: `src/device-manager.ts`

**Step 1: Add aurora to Platform type and import AuroraClient**

```typescript
// Add to imports
import { auroraClient as aurora } from "./aurora/index.js";

// Update Platform type
export type Platform = "android" | "ios" | "desktop" | "aurora";
```

**Step 2: Add auroraClient property and getClient method**

```typescript
// In DeviceManager class, add:
private aurora = aurora;

// Add getClient private method:
private getClient(platform: Platform) {
  switch (platform) {
    case "android": return this.android;
    case "ios": return this.ios;
    case "desktop": return this.desktop;
    case "aurora": return this.aurora;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}
```

**Step 3: Update screenshot method to support aurora**

```typescript
// In DeviceManager class, update screenshot():
async screenshot(
  platform?: Platform,
  compress = true,
  options?: { maxWidth?: number; maxHeight?: number; quality?: number }
): Promise<{ data: string; mimeType: string }> {
  const p = platform ?? this.getCurrentPlatform();
  return await this.getClient(p).screenshot({ compress, ...options });
}
```

**Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/device-manager.ts
git commit -m "feat: integrate Aurora platform into DeviceManager"
```

---

## Task 9: Add Aurora Tools to MCP Server

**Files:**
- Modify: `src/index.ts`

**Step 1: Update platformParam enum**

```typescript
// In src/index.ts, update platformParam:
const platformParam = {
  type: "string",
  enum: ["android", "ios", "desktop", "aurora"],
  description: "Target platform. If not specified, uses the active target.",
};
```

**Step 2: Add push_file and pull_file tools**

```typescript
// Add to tools array after line 600 (after get_monitors):

{
  name: "push_file",
  description: "Upload file to Aurora OS device",
  inputSchema: {
    type: "object",
    properties: {
      platform: { ...platformParam, const: "aurora" },
      localPath: { type: "string", description: "Local file path" },
      remotePath: { type: "string", description: "Remote destination path" },
    },
    required: ["localPath", "remotePath"],
  },
},
{
  name: "pull_file",
  description: "Download file from Aurora OS device",
  inputSchema: {
    type: "object",
    properties: {
      platform: { const: "aurora" },
      remotePath: { type: "string" },
      localPath: { type: "string", description: "Optional local path" },
    },
    required: ["remotePath"],
  },
},
```

**Step 3: Add tool handlers in handleTool switch**

```typescript
// Add to handleTool function, after the get_monitors case:

case "push_file": {
  const result = await deviceManager.getAurora().pushFile(
    args.localPath as string,
    args.remotePath as string
  );
  return { text: result };
}

case "pull_file": {
  const buffer = await deviceManager.getAurora().pullFile(
    args.remotePath as string,
    args.localPath as string | undefined
  );
  return { text: `Downloaded ${args.remotePath} (${buffer.length} bytes)` };
}
```

**Step 4: Add getAurora helper to DeviceManager**

```typescript
// Add to DeviceManager class:
getAurora() {
  return this.aurora;
}
```

**Step 5: Update list_devices handler to show Aurora devices**

```typescript
// Update list_devices case to include aurora:
const aurora = devices.filter(d => d.platform === "aurora");

// Add to output:
if (aurora.length > 0) {
  result += "\nAurora:\n";
  for (const d of aurora) {
    const active = activeDevice?.id === d.id && activeTarget === "aurora" ? " [ACTIVE]" : "";
    result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
  }
}
```

**Step 6: Update server version**

```typescript
// Update server version in main():
new Server(
  {
    name: "claude-mobile",
    version: "2.8.0",  // Bump from 2.7.0
  },
  // ...
);
```

**Step 7: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add src/index.ts src/device-manager.ts
git commit -m "feat: add Aurora tools to MCP server (push_file, pull_file)"
```

---

## Task 10: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add Aurora to features list**

```markdown
## Features

- **Unified API** — Same commands work for Android, iOS, Desktop, and Aurora OS
```

**Step 2: Add Aurora to requirements**

```markdown
## Requirements

### Aurora OS
- audb CLI installed and in PATH (`cargo install audb-client`)
- Connected Aurora OS device with SSH enabled
- Python 3 on device (`devel-su pkcon install python3`)
```

**Step 3: Add Aurora to tools table**

```markdown
## Available Tools

| Tool | Android | iOS | Desktop | Aurora | Description |
|------|---------|-----|---------|--------|-------------|
| list_devices | ✅ | ✅ | ✅ | ✅ | List all connected devices |
| screenshot | ✅ | ✅ | ✅ | ✅ | Take screenshot |
| tap | ✅ | ✅ | ✅ | ✅ | Tap at coordinates |
| swipe | ✅ | ✅ | ✅ | ✅ | Swipe gesture |
| press_key | ✅ | ✅ | ✅ | ✅ | Press hardware buttons |
| launch_app | ✅ | ✅ | ❌ | ✅ | Launch app |
| stop_app | ✅ | ✅ | ❌ | ✅ | Stop app |
| install_app | ✅ | ✅ | ❌ | ✅ | Install RPM package |
| shell | ✅ | ✅ | ❌ | ✅ | Run shell command |
| get_logs | ✅ | ✅ | ❌ | ✅ | Get device logs |
| push_file | ❌ | ❌ | ❌ | ✅ | Upload file (Aurora only) |
| pull_file | ❌ | ❌ | ❌ | ✅ | Download file (Aurora only) |
```

**Step 4: Add Aurora usage examples**

```markdown
### Aurora Examples

```
"List Aurora devices"
"Take a screenshot on Aurora"
"Tap at coordinates 100, 200 on Aurora"
"Launch ru.example.app on Aurora"
"Get logs from Aurora device"
"Push file.txt to Aurora device"
```
```

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add Aurora OS support to README"
```

---

## Task 11: Manual Testing

**Files:** None

**Step 1: Build the project**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 2: Test with Claude Code**

```bash
# Start MCP server
npx ts-node src/index.ts

# In another terminal, test via Claude Code
claude mcp add --transport stdio aurora-test -- npx -y ts-node src/index.ts
```

**Step 3: Test list_devices**

Prompt: "List all connected devices"
Expected: Shows Aurora device if connected

**Step 4: Test screenshot**

Prompt: "Take a screenshot on Aurora"
Expected: Returns screenshot image

**Step 5: Test tap**

Prompt: "Tap at 360, 720 on Aurora"
Expected: Executes tap on device

**Step 6: Test shell**

Prompt: "Run 'uname -a' on Aurora"
Expected: Returns system info

**Step 7: Test file push**

Create test file: `echo "test" > /tmp/test.txt`
Prompt: "Push /tmp/test.txt to /home/defaultuser/test.txt on Aurora"
Expected: File uploaded

**No commit - manual testing only**

---

## Task 12: Release Preparation

**Files:**
- Modify: `package.json`

**Step 1: Bump version**

```json
{
  "version": "2.8.0"
}
```

**Step 2: Update changelog**

Create: `CHANGELOG.md`

```markdown
# Changelog

## [2.8.0] - 2026-01-21

### Added
- Aurora OS platform support via audb CLI
- push_file and pull_file tools for file transfer
- Support for 18 Aurora tools: tap, swipe, press_key, launch_app, stop_app, install_app, shell, logs, screenshot, etc.

### Changed
- Updated platform enum to include "aurora"
- Updated README with Aurora OS requirements and examples
```

**Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 2.8.0 and add changelog"
```

**Step 4: Tag release**

```bash
git tag v2.8.0
git push origin main --tags
```

---

## Summary

This plan adds complete Aurora OS support to claude-in-mobile:

**12 Tasks, ~30-45 minutes total**

- AuroraClient with all methods
- DeviceManager integration
- 18 MCP tools (including 2 new Aurora-specific)
- Documentation updates

**Limitations documented:**
- No UI hierarchy tools (get_ui, find_element, analyze_screen, find_and_tap)
- No input_text (TODO: research DBus/clipboard workaround)
- Requires audb CLI installed
- Requires Python 3 on device for tap/swipe
