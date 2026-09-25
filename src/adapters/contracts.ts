/**
 * Minimal structural contracts for plugin clients used by the base package.
 *
 * Concrete implementations live in separate `@mcp-devices/plugin-*` packages,
 * so these types intentionally describe only the methods consumed here.
 */

export interface BrowserAdapterLike {
  open(options: Record<string, unknown>): Promise<string>;
  closeSession(session?: string): Promise<void>;
  listSessions(): string[];
  navigate(options: Record<string, unknown>): Promise<string>;
  clickElement(options: Record<string, unknown>): Promise<string>;
  fillField(options: Record<string, unknown>): Promise<void>;
  fillForm(options: Record<string, unknown>): Promise<void>;
  snapshot(session?: string): Promise<string>;
  screenshotBrowser(session?: string, fullPage?: boolean): Promise<Buffer>;
  evaluateJs(expression: string, session?: string): Promise<string>;
  waitForSelector(
    selector: string,
    timeout?: number,
    state?: "attached" | "visible",
    session?: string,
  ): Promise<void>;
  clearSessionData(session: string): Promise<void>;
  sessionManager: {
    getSession(session?: string): unknown;
  };
  client: {
    pressKey(session: unknown, key: string): Promise<void>;
  };
}

export interface DesktopStateLike {
  status: string;
  crashCount: number;
  lastError?: string;
}

export interface DesktopAdapterLike {
  launch(options: RawLaunchOptionsLike): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getClient(): DesktopClientLike;
  getState(): DesktopStateLike;
}

export interface DesktopWindowLike {
  id: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
  processId?: number;
}

export interface DesktopClientLike {
  tapByText(text: string, pid?: number, exactMatch?: boolean): Promise<{
    success: boolean;
    elementRole?: string;
    error?: string;
  }>;
  getWindowInfo(): Promise<{ windows: DesktopWindowLike[] }>;
  focusWindow(windowId: string): Promise<void>;
  resizeWindow(width: number, height: number, windowId?: string): Promise<void>;
  getClipboard(): Promise<string>;
  setClipboard(text: string): Promise<void>;
  getPerformanceMetrics(): Promise<{
    memoryUsageMb?: number;
    cpuPercent?: number;
    fps?: number;
  }>;
  getMonitors(): Promise<Array<{
    index: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isPrimary: boolean;
  }>>;
  getTargetPid(): number | null;
  getState(): DesktopStateLike;
}

export type RawLaunchOptionsLike = Record<string, unknown>;

export interface IosElementLike {
  ELEMENT: string;
  type?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface IosClientLike {
  openUrl(url: string, deviceId?: string): void | Promise<void>;
  getScreenPointSize(deviceId?: string): Promise<{ width: number; height: number }>;
  findElement(options: Record<string, unknown>): Promise<IosElementLike>;
  findElements(options: Record<string, unknown>): Promise<IosElementLike[]>;
  getElementRect(elementId: string): Promise<IosElementLike["rect"] | null>;
  tapElement(elementId: string): Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface AdbClientLike {
  exec(command: string): string;
  execWithUiDump(
    actionArgs: readonly string[],
    deviceIdOverride?: string,
    signal?: AbortSignal,
  ): Promise<{ actionOutput: string; uiXml: string }>;
  getCurrentActivity(): string;
  getBatteryInfo(): string;
  selectAll(): void;
  copyToClipboard(): void;
  pasteFromClipboard(): void;
  getClipboardText(): string;
  tap(x: number, y: number): void;
}

export interface WebViewInspectorLike {
  inspect(): Promise<{
    sockets: string[];
    forwardedPort: number;
    targets: Array<{ type: string; title: string; url: string; id: string }>;
  }>;
  cleanup(): void;
}

export interface AuroraClientLike {
  listPackages(): string[];
  pushFile(localPath: string, remotePath: string): string;
  pullFile(remotePath: string, localPath?: string): Buffer;
}
