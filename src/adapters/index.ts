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
// AuroraAdapter moved to @mcp-devices/plugin-aurora (4.0.0 physical split).
