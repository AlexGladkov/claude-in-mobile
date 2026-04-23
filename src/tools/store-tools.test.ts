import { describe, it, expect, vi } from "vitest";
import { storeTools } from "./store-tools.js";
import { MobileError, ValidationError } from "../errors.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = storeTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in storeTools`);
  return def.handler;
}

// Store tools handlers don't use ctx (they use the module-level Google Play
// client), but the handler signature requires it. We pass a minimal mock.
// However, validation happens before the client call, so it will throw before
// reaching the client.
const dummyCtx = {} as any;

// ──────────────────────────────────────────────
// store_upload — security validation
// ──────────────────────────────────────────────

describe("store_upload", () => {
  const handler = findHandler("store_upload");

  it("throws INVALID_PACKAGE_NAME for package with semicolon injection", async () => {
    await expect(
      handler({ packageName: "com.example;rm", filePath: "/path/to/app.aab" }, dummyCtx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ packageName: "com.example;rm", filePath: "/path/to/app.aab" }, dummyCtx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });

  it("throws INVALID_PACKAGE_NAME for empty package name", async () => {
    await expect(
      handler({ packageName: "", filePath: "/path/to/app.aab" }, dummyCtx)
    ).rejects.toThrow(MobileError);
  });

  it("throws PATH_TRAVERSAL_BLOCKED for path traversal in filePath", async () => {
    await expect(
      handler({ packageName: "com.example.app", filePath: "../../etc/passwd" }, dummyCtx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ packageName: "com.example.app", filePath: "../../etc/passwd" }, dummyCtx);
    } catch (e) {
      expect((e as MobileError).code).toBe("PATH_TRAVERSAL_BLOCKED");
    }
  });

  it("throws PATH_TRAVERSAL_BLOCKED for relative path traversal", async () => {
    await expect(
      handler({ packageName: "com.example.app", filePath: "/builds/../../../secret.aab" }, dummyCtx)
    ).rejects.toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// store_set_notes — validation
// ──────────────────────────────────────────────

describe("store_set_notes", () => {
  const handler = findHandler("store_set_notes");

  it("throws ValidationError for text exceeding 500 characters", async () => {
    const longText = "A".repeat(501);
    await expect(
      handler({ packageName: "com.example.app", language: "en-US", text: longText }, dummyCtx)
    ).rejects.toThrow(ValidationError);

    try {
      await handler({ packageName: "com.example.app", language: "en-US", text: longText }, dummyCtx);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe("VALIDATION_ERROR");
      expect((e as ValidationError).message).toContain("500");
    }
  });

  it("throws ValidationError for text at 501 characters boundary", async () => {
    const text = "B".repeat(501);
    await expect(
      handler({ packageName: "com.example.app", language: "en-US", text }, dummyCtx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws INVALID_PACKAGE_NAME for invalid package name", async () => {
    await expect(
      handler({ packageName: "bad;pkg", language: "en-US", text: "notes" }, dummyCtx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ packageName: "bad;pkg", language: "en-US", text: "notes" }, dummyCtx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });
});
