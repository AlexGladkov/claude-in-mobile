import { describe, expect, it, vi } from "vitest";
import { assertAndroidDebuggable, DebugValidationError } from "./exec.js";

describe("assertAndroidDebuggable", () => {
  it("fails closed when package metadata cannot be read", async () => {
    const adb = vi.fn(async () => {
      throw new Error("device disconnected");
    });

    await expect(assertAndroidDebuggable(adb, "com.example.app")).rejects.toMatchObject({
      code: "DEBUGGABLE_CHECK_FAILED",
    } satisfies Partial<DebugValidationError>);
  });

  it("rejects package metadata without a debuggable flag", async () => {
    const adb = vi.fn(async () => "Package [com.example.app] (123):\n  userId=10123\n");

    await expect(assertAndroidDebuggable(adb, "com.example.app")).rejects.toMatchObject({
      code: "PACKAGE_NOT_DEBUGGABLE",
    } satisfies Partial<DebugValidationError>);
  });

  it("accepts metadata with the debuggable package flag", async () => {
    const adb = vi.fn(async () => "pkgFlags=[ DEBUGGABLE HAS_CODE ]\n");

    await expect(assertAndroidDebuggable(adb, "com.example.app")).resolves.toBeUndefined();
  });
});
