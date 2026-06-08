import type { Platform } from "../device-manager.js";
import type { ToolContext } from "../tools/context.js";

export interface CommonArgs {
  deviceId?: string;
  platform: Platform;
}

const VALID: ReadonlyArray<Platform> = ["android", "ios", "desktop", "aurora", "browser"];

const isPlatform = (v: unknown): v is Platform =>
  typeof v === "string" && (VALID as readonly string[]).includes(v);

/**
 * Extract `deviceId` and `platform` from raw tool args. Falls back to the
 * currently active platform when `platform` is omitted.
 *
 * Centralises a ~125-callsite pattern.
 */
export function parseCommonArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): CommonArgs {
  const deviceId = typeof args.deviceId === "string" ? args.deviceId : undefined;
  const platform = isPlatform(args.platform)
    ? args.platform
    : ctx.deviceManager.getCurrentPlatform();
  return { deviceId, platform };
}
