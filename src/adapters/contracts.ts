/**
 * Structural ("…Like") views of platform clients/adapters.
 *
 * After the 4.0.0 physical split, the concrete implementations live in the
 * separate `@mcp-devices/plugin-*` packages, so the base package (device
 * manager, tools, facades) must NOT import them. These permissive structural
 * types let base code keep calling the legacy `getXClient()` / `getXAdapter()`
 * escape hatches without a build-time dependency on the implementation.
 *
 * Trade-off: these are intentionally loose (index-signature `any`) — full
 * type-safety on these escape hatches now lives in the platform packages.
 * Prefer the typed `CorePlatformAdapter` capability interfaces where possible.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Named methods document + name-check the surface base tools actually call;
// the index signature stays as the escape hatch for internal field access
// (e.g. `.client`, `.sessionManager`) whose full types live in the package.
export interface BrowserAdapterLike {
  open(...args: any[]): any;
  closeSession(...args: any[]): any;
  listSessions(...args: any[]): any;
  navigate(...args: any[]): any;
  clickElement(...args: any[]): any;
  fillField(...args: any[]): any;
  fillForm(...args: any[]): any;
  snapshot(...args: any[]): any;
  screenshotBrowser(...args: any[]): any;
  clearSessionData(...args: any[]): any;
  [key: string]: any;
}

export interface DesktopAdapterLike {
  launch(...args: any[]): any;
  stop(...args: any[]): any;
  isRunning(...args: any[]): any;
  getClient(...args: any[]): any;
  getState(...args: any[]): any;
  [key: string]: any;
}

export interface DesktopClientLike {
  tapByText(...args: any[]): any;
  getWindowInfo(...args: any[]): any;
  focusWindow(...args: any[]): any;
  getClipboard(...args: any[]): any;
  setClipboard(...args: any[]): any;
  getPerformanceMetrics(...args: any[]): any;
  getMonitors(...args: any[]): any;
  getTargetPid(...args: any[]): any;
  [key: string]: any;
}

/** Shape of desktop launch options — loose; concrete type lives in plugin-desktop. */
export type RawLaunchOptionsLike = Record<string, unknown>;

export interface IosClientLike {
  openUrl(url: string, deviceId?: string): void | Promise<void>;
  cleanup(): void;
  [key: string]: any;
}

export interface AdbClientLike {
  [key: string]: any;
}

export interface WebViewInspectorLike {
  inspect(): Promise<any>;
  cleanup(): void;
  [key: string]: any;
}

export interface AuroraClientLike {
  listPackages(): string[];
  pushFile(localPath: string, remotePath: string): string;
  pullFile(remotePath: string, localPath?: string): Buffer;
}
