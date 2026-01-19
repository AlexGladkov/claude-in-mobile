/**
 * Desktop platform types for claude-in-mobile
 */
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: JsonRpcError;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface DesktopWindow {
    id: string;
    title: string;
    bounds: Bounds;
    focused: boolean;
    minimized: boolean;
    fullscreen: boolean;
    processId?: number;
    ownerName?: string;
}
export interface WindowInfo {
    windows: DesktopWindow[];
    activeWindowId: string | null;
}
export interface DesktopUiElement {
    index: number;
    id?: string;
    text?: string;
    contentDescription?: string;
    className: string;
    role?: string;
    bounds: Bounds;
    clickable: boolean;
    enabled: boolean;
    focused: boolean;
    focusable: boolean;
    children: DesktopUiElement[];
    centerX: number;
    centerY: number;
}
export interface UiHierarchy {
    windows: DesktopWindow[];
    elements: DesktopUiElement[];
    scaleFactor: number;
}
export interface ScreenshotOptions {
    windowId?: string;
    quality?: number;
    monitorIndex?: number;
}
export interface ScreenshotResult {
    base64: string;
    width: number;
    height: number;
    scaleFactor: number;
    mimeType: "image/jpeg";
}
export interface TapOptions {
    x: number;
    y: number;
}
export interface SwipeOptions {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    durationMs?: number;
}
export interface KeyEventOptions {
    key: string;
    modifiers?: string[];
}
export interface LaunchOptions {
    projectPath?: string;
    task?: string;
    jvmArgs?: string[];
    env?: Record<string, string>;
}
export interface GradleProject {
    path: string;
    desktopTasks: string[];
    selectedTask?: string;
}
export type LogType = "stdout" | "stderr" | "compose" | "crash";
export interface LogEntry {
    timestamp: number;
    type: LogType;
    message: string;
}
export interface LogOptions {
    type?: LogType;
    since?: number;
    limit?: number;
}
export interface PerformanceMetrics {
    fps?: number;
    memoryUsageMb: number;
    cpuPercent?: number;
}
export interface PermissionStatus {
    granted: boolean;
    instructions?: string[];
}
export type DesktopStatus = "stopped" | "starting" | "running" | "crashed";
export interface DesktopState {
    status: DesktopStatus;
    pid?: number;
    projectPath?: string;
    crashCount: number;
    lastError?: string;
}
export interface ClipboardContent {
    text?: string;
    hasImage?: boolean;
}
export interface MonitorInfo {
    index: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isPrimary: boolean;
}
export interface MonitorsResult {
    monitors: MonitorInfo[];
}
//# sourceMappingURL=types.d.ts.map