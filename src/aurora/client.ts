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

  async getActiveDevice(): Promise<string> {
    try {
      const path = `${process.env.HOME}/.config/audb/current_device`;
      return await fs.readFile(path, "utf-8");
    } catch {
      throw new Error("No device selected");
    }
  }
}

export const auroraClient = new AuroraClient();

