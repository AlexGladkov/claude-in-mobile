/**
 * Structural ("…Like") views of platform clients/adapters.
 *
 * After the 4.0.0 physical split, the concrete implementations live in the
 * separate `@claude-in-mobile/plugin-*` packages, so the base package (device
 * manager, tools, facades) must NOT import them. These permissive structural
 * types let base code keep calling the legacy `getXClient()` / `getXAdapter()`
 * escape hatches without a build-time dependency on the implementation.
 *
 * Trade-off: these are intentionally loose (index-signature `any`) — full
 * type-safety on these escape hatches now lives in the platform packages.
 * Prefer the typed `CorePlatformAdapter` capability interfaces where possible.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BrowserAdapterLike {
  [key: string]: any;
}

export interface DesktopAdapterLike {
  [key: string]: any;
}

export interface DesktopClientLike {
  [key: string]: any;
}

/** Shape of desktop launch options — loose; concrete type lives in plugin-desktop. */
export type RawLaunchOptionsLike = Record<string, unknown>;

export interface AuroraClientLike {
  listPackages(): string[];
  pushFile(localPath: string, remotePath: string): string;
  pullFile(remotePath: string, localPath?: string): Buffer;
}
