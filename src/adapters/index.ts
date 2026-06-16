// Segregated interfaces
export type {
  CorePlatformAdapter,
  AppManagementAdapter,
  PermissionAdapter,
  ShellAdapter,
  SyncScreenshotAdapter,
  PlatformAdapter,
} from "./platform-adapter.js";

// Type guards
export {
  hasAppManagement,
  hasPermissions,
  hasShell,
  hasSyncScreenshot,
} from "./platform-adapter.js";

// Concrete adapters
export { AndroidAdapter } from "./android-adapter.js";
export { IosAdapter } from "./ios-adapter.js";
export { DesktopAdapter } from "./desktop-adapter.js";
// AuroraAdapter moved to @claude-in-mobile/plugin-aurora (4.0.0 physical split).
export { BrowserAdapter } from "./browser-adapter.js";
