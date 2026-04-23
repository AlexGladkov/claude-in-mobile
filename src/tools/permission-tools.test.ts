import { describe, it, expect, vi } from "vitest";
import { permissionTools } from "./permission-tools.js";
import { MobileError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = permissionTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in permissionTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      grantPermission: vi.fn(() => "Permission granted"),
      revokePermission: vi.fn(() => "Permission revoked"),
      resetPermissions: vi.fn(() => "Permissions reset"),
      getCurrentPlatform: vi.fn(() => "android"),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// permission_grant — validation
// ──────────────────────────────────────────────

describe("permission_grant", () => {
  const handler = findHandler("permission_grant");

  it("throws INVALID_PACKAGE_NAME for package with semicolon injection", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example;rm", permission: "android.permission.CAMERA" }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ package: "com.example;rm", permission: "android.permission.CAMERA" }, ctx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });

  it("throws INVALID_PERMISSION for permission with semicolon injection", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", permission: "bad;perm" }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ package: "com.example.app", permission: "bad;perm" }, ctx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PERMISSION");
    }
  });

  it("throws INVALID_PERMISSION for permission with pipe injection", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", permission: "perm|hack" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws INVALID_PERMISSION for permission with $() injection", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", permission: "perm$(cmd)" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws INVALID_PERMISSION for empty permission", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", permission: "" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("accepts valid package and permission", async () => {
    const ctx = makeMockContext();
    const result = await handler({
      package: "com.example.app",
      permission: "android.permission.CAMERA",
    }, ctx);
    expect(result).toEqual({ text: "Permission granted" });
  });
});

// ──────────────────────────────────────────────
// permission_revoke — validation
// ──────────────────────────────────────────────

describe("permission_revoke", () => {
  const handler = findHandler("permission_revoke");

  it("throws INVALID_PACKAGE_NAME for invalid package", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "bad;pkg", permission: "android.permission.CAMERA" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws INVALID_PERMISSION for invalid permission", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", permission: "bad perm" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("does not throw for valid inputs", async () => {
    const ctx = makeMockContext();
    const result = await handler({
      package: "com.example.app",
      permission: "android.permission.READ_EXTERNAL_STORAGE",
    }, ctx);
    expect(result).toEqual({ text: "Permission revoked" });
    expect(ctx.deviceManager.revokePermission).toHaveBeenCalledWith(
      "com.example.app",
      "android.permission.READ_EXTERNAL_STORAGE",
      undefined
    );
  });
});
