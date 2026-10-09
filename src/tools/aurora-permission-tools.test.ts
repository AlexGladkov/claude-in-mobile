import { describe, expect, it, vi } from "vitest";
import { systemMeta, systemAliases } from "./meta/system-meta.js";
import type { ToolContext } from "./context.js";

function context() {
  const client = {
    permissionList: vi.fn(() => "listed"), grantAllPermissions: vi.fn(() => "granted"),
    permissionPrompt: vi.fn(() => "prompt"), grantPermission: vi.fn(() => "selected grant"),
  };
  const manager = {
    getCurrentPlatform: vi.fn(() => "aurora"), getAuroraClient: vi.fn(() => client),
    grantPermission: vi.fn(() => "grant"), revokePermission: vi.fn(() => "revoke"), resetPermissions: vi.fn(() => "reset"),
  };
  return { client, manager, ctx: { deviceManager: manager } as unknown as ToolContext };
}
describe("Aurora permissions through system MCP", () => {
  it("routes list, grant-all and explicit prompt to the requested device", async () => {
    const { client, manager, ctx } = context();
    const args = { platform: "aurora", deviceId: "phone", package: "ru.example.app" };
    await systemMeta.handler({ ...args, action: "permission_list" }, ctx);
    await systemMeta.handler({ ...args, action: "permission_grant_all" }, ctx);
    await systemMeta.handler({ ...args, action: "permission_grant_all", disablePrompt: true }, ctx);
    await systemMeta.handler({ ...args, action: "permission_prompt", enabled: false }, ctx);
    expect(client.permissionList).toHaveBeenCalledWith(args.package);
    expect(client.grantAllPermissions.mock.calls).toEqual([[args.package, false], [args.package, true]]);
    expect(client.permissionPrompt).toHaveBeenCalledWith(args.package, false);
    expect(manager.getAuroraClient.mock.calls).toEqual([["phone"], ["phone"], ["phone"], ["phone"]]);
    expect(systemAliases.permission_list.defaults.action).toBe("permission_list");
  });
  it("preserves generic grant and forwards disablePrompt only when explicit", async () => {
    const { client, manager, ctx } = context();
    const args = { action: "permission_grant", platform: "aurora", deviceId: "emulator", package: "ru.example.app", permission: "UserDirs" };
    await systemMeta.handler(args, ctx);
    expect(manager.grantPermission).toHaveBeenCalledWith(args.package, "UserDirs", "aurora", "emulator");
    await systemMeta.handler({ ...args, disablePrompt: true }, ctx);
    expect(client.grantPermission).toHaveBeenCalledWith(args.package, "UserDirs", true);
    await expect(systemMeta.handler({ ...args, platform: "android", disablePrompt: false }, ctx)).rejects.toThrow(/Aurora/);
  });
  it("rejects missing prompt state and other platforms before making changes", async () => {
    const { client, manager, ctx } = context();
    await expect(systemMeta.handler({ action: "permission_prompt", platform: "aurora", package: "ru.example.app" }, ctx)).rejects.toThrow(/enabled/);
    await expect(systemMeta.handler({ action: "permission_grant_all", platform: "android", package: "ru.example.app" }, ctx)).rejects.toThrow();
    expect(manager.getAuroraClient).not.toHaveBeenCalled(); expect(client.grantAllPermissions).not.toHaveBeenCalled();
  });
});
