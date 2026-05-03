import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { platform } from "os";
import { join } from "path";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, execSync: vi.fn() };
});

import { resolveAdbPath, _resetCacheForTests, quoteAdbPath } from "./resolver.js";
import { execSync } from "child_process";
import { AdbNotInstalledError } from "../errors.js";

const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;
const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;
const isWin = platform() === "win32";
const adbBin = isWin ? "adb.exe" : "adb";

const ENV_KEYS = ["ADB_PATH", "ANDROID_HOME", "ANDROID_SDK_ROOT"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockExists.mockReset().mockReturnValue(false);
  mockExec.mockReset().mockImplementation(() => {
    throw new Error("not found");
  });
  _resetCacheForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("resolveAdbPath", () => {
  it("returns ADB_PATH when set and file exists", () => {
    process.env.ADB_PATH = "/custom/adb";
    mockExists.mockImplementation((p) => p === "/custom/adb");

    expect(resolveAdbPath()).toBe("/custom/adb");
  });

  it("prefers ADB_PATH over ANDROID_HOME when both exist", () => {
    process.env.ADB_PATH = "/custom/adb";
    process.env.ANDROID_HOME = "/sdk-home";
    mockExists.mockReturnValue(true); // both exist

    expect(resolveAdbPath()).toBe("/custom/adb");
  });

  it("falls back to ANDROID_HOME when ADB_PATH not set", () => {
    const root = isWin ? "C:\\sdk-home" : "/sdk-home";
    process.env.ANDROID_HOME = root;
    const expected = join(root, "platform-tools", adbBin);
    mockExists.mockImplementation((p) => p === expected);

    expect(resolveAdbPath()).toBe(expected);
  });

  it("falls back to ANDROID_SDK_ROOT after ANDROID_HOME", () => {
    const root = isWin ? "C:\\sdk-root" : "/sdk-root";
    process.env.ANDROID_SDK_ROOT = root;
    const expected = join(root, "platform-tools", adbBin);
    mockExists.mockImplementation((p) => p === expected);

    expect(resolveAdbPath()).toBe(expected);
  });

  it("falls back to PATH when no candidate file exists", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockReturnValue(Buffer.from("found"));

    expect(resolveAdbPath()).toBe("adb");
  });

  it("throws AdbNotInstalledError listing all probed paths when nothing works", () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation(() => {
      throw new Error("not found");
    });

    let captured: AdbNotInstalledError | null = null;
    try {
      resolveAdbPath();
    } catch (e) {
      captured = e as AdbNotInstalledError;
    }

    expect(captured).toBeInstanceOf(AdbNotInstalledError);
    expect(captured?.code).toBe("ADB_NOT_INSTALLED");
    expect(captured?.message).toContain("Probed locations:");
    expect(captured?.message).toContain("PATH: adb");
  });

  it("memoizes the resolved path across calls", () => {
    process.env.ADB_PATH = "/custom/adb";
    mockExists.mockImplementation((p) => p === "/custom/adb");

    const first = resolveAdbPath();
    mockExists.mockReturnValue(false); // would fail second time if not cached

    expect(resolveAdbPath()).toBe(first);
  });
});

describe("quoteAdbPath", () => {
  it("does not quote bare 'adb'", () => {
    expect(quoteAdbPath("adb")).toBe("adb");
    expect(quoteAdbPath("adb.exe")).toBe("adb.exe");
  });

  it("quotes paths with spaces", () => {
    expect(quoteAdbPath("/Program Files/adb.exe")).toBe('"/Program Files/adb.exe"');
  });

  it("does not double-quote already-quoted paths", () => {
    expect(quoteAdbPath('"/already/quoted"')).toBe('"/already/quoted"');
  });
});
