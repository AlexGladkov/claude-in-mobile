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
export { AuroraAdapter } from "./aurora-adapter.js";
export { BrowserAdapter } from "./browser-adapter.js";
