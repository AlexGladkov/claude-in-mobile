// Segregated interfaces
export type {
  CorePlatformAdapter,
  AppManagementAdapter,
  AppInventoryAdapter,
  PermissionAdapter,
  ShellAdapter,
  LogsAdapter,
  FileTransferAdapter,
  UrlOpeningAdapter,
  SyncScreenshotAdapter,
  PerformanceTraceAdapter,
  PerformanceTraceStartOptions,
  PerformanceTraceHandle,
  PerformanceTraceCapture,
  PerformanceTraceSummary,
  PerformanceTraceFrameStats,
  PerformanceTracePreset,
  PerformanceTraceFormat,
  HeapSnapshotAdapter,
  HeapSnapshotOptions,
  HeapSnapshotCapture,
  HeapSnapshotSummary,
  HeapSnapshotFormat,
  PlatformAdapter,
} from "./platform-adapter.js";

// Type guards
export {
  hasDeviceManagement,
  hasInput,
  hasScreen,
  hasUi,
  hasAppManagement,
  hasAppInventory,
  hasPermissions,
  hasShell,
  hasLogs,
  hasFileTransfer,
  hasUrlOpening,
  hasSyncScreenshot,
  hasPerformanceTrace,
  requirePerformanceTrace,
  hasHeapSnapshot,
  requireHeapSnapshot,
  setAdapterCapabilities,
  getAdapterCapabilities,
} from "./platform-adapter.js";

// Concrete adapters
// AuroraAdapter moved to @mcp-devices/plugin-aurora (4.0.0 physical split).
