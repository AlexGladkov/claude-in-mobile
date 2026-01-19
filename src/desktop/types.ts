/**
 * Desktop platform types for claude-in-mobile
 */

// JSON-RPC protocol types
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

// Geometry types
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Window types
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

// UI element types (unified with Android format)
export interface DesktopUiElement {
  index: number;
  id?: string;
  text?: string;
  contentDescription?: string;
  className: string;
  role?: string; // Accessibility role (button, textfield, etc.)
  bounds: Bounds;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  focusable: boolean;
  children: DesktopUiElement[];
  // Computed coordinates
  centerX: number;
  centerY: number;
}

export interface UiHierarchy {
  windows: DesktopWindow[];
  elements: DesktopUiElement[];
  scaleFactor: number;
}

// Screenshot types
export interface ScreenshotOptions {
  windowId?: string;
  quality?: number; // JPEG quality 1-100, default 80
  monitorIndex?: number; // Monitor index for multi-monitor support (captures all monitors if not specified)
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  scaleFactor: number;
  mimeType: "image/jpeg";
}

// Input types
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
  modifiers?: string[]; // "ctrl", "shift", "alt", "meta"
}

// Launch options
export interface LaunchOptions {
  projectPath?: string; // If provided, also launches user's Compose Desktop app via Gradle
  task?: string; // Gradle task, auto-detected if not specified
  jvmArgs?: string[];
  env?: Record<string, string>;
}

export interface GradleProject {
  path: string;
  desktopTasks: string[];
  selectedTask?: string;
}

// Log types
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

// Performance metrics
export interface PerformanceMetrics {
  fps?: number;
  memoryUsageMb: number;
  cpuPercent?: number;
}

// Permission status
export interface PermissionStatus {
  granted: boolean;
  instructions?: string[];
}

// Desktop client status
export type DesktopStatus = "stopped" | "starting" | "running" | "crashed";

export interface DesktopState {
  status: DesktopStatus;
  pid?: number;
  projectPath?: string;
  crashCount: number;
  lastError?: string;
}

// Clipboard types
export interface ClipboardContent {
  text?: string;
  hasImage?: boolean;
}

// Monitor types (multi-monitor support)
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
