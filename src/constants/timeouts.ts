/**
 * Single source of truth for all timeouts/intervals.
 * Group by domain. Document any non-trivial choice with WHY.
 */

export const ADB = {
  DEFAULT_EXEC_MS: 15_000,
  LONG_EXEC_MS: 30_000,
} as const;

export const DESKTOP = {
  RPC_TIMEOUT_MS: 45_000,
  CONNECT_TIMEOUT_MS: 5_000,
  POLL_INTERVAL_MS: 100,
} as const;

export const WDA = {
  SESSION_CREATE_MS: 30_000,
  BOOT_MS: 120_000,
  REQUEST_MS: 10_000,
} as const;

export const KERNEL = {
  PLUGIN_INIT_MS: 10_000,
  PLUGIN_DISPOSE_MS: 5_000,
} as const;

export const FLOW = {
  MAX_STEPS: 20,
  MAX_DURATION_MS: 60_000,
  UI_TREE_TIMEOUT_MS: 800,
  STEP_DELAY_TURBO_MS: 100,
  STEP_DELAY_NORMAL_MS: 300,
} as const;

export const REPL = {
  /** Public `repl_expect` idle wait default. */
  EXPECT_IDLE_DEFAULT_MS: 300,
  /** Public `repl_expect` idle wait maximum enforced by the supervisor. */
  EXPECT_IDLE_MAX_MS: 60_000,
  /** Public `repl_expect` timeout default. */
  EXPECT_TIMEOUT_DEFAULT_MS: 5_000,
  /** Public `repl_expect` timeout maximum enforced by the supervisor. */
  EXPECT_TIMEOUT_MAX_MS: 300_000,
  /** Extra time reserved for the bridge request round-trip. */
  EXPECT_TIMEOUT_BUFFER_MS: 5_000,
  /** Maximum client request timeout: public expect maximum plus its buffer. */
  REQUEST_TIMEOUT_MAX_MS: 305_000,
} as const;

export const RECORDER = {
  PLAYBACK_MAX_STEP_TIMEOUT_MS: 30_000,
} as const;

export const SYNC = {
  BARRIER_TIMEOUT_MS: 30_000,
} as const;

export const PERFORMANCE = {
  MAX_MONITOR_DURATION_MS: 30_000,
  POLL_INTERVAL_MS: 500,
  /** Native trace windows stay bounded to control trace volume and app perturbation. */
  MAX_TRACE_DURATION_MS: 15_000,
} as const;

export const SCREEN = {
  /** Wait between captures for two-frame stability check. */
  STABLE_INTERVAL_MS: 300,
  STABLE_MAX_RETRIES: 3,
} as const;

export const CLIPBOARD = {
  POLL_MS: 100,
  SETTLE_MS: 200,
} as const;

export const XCODE = {
  /** `xcodebuild archive` of a real app can take 10+ min on cold DerivedData. */
  ARCHIVE_TIMEOUT_MS: 15 * 60_000,
  /** `-exportArchive` re-signs the bundle; usually < 2 min, 10 gives headroom. */
  EXPORT_TIMEOUT_MS: 10 * 60_000,
  /** altool upload to App Store Connect — network-bound for large IPAs. */
  UPLOAD_TIMEOUT_MS: 10 * 60_000,
  /** `xcodebuild -list -json` resolves SPM deps on first run — not instant. */
  LIST_TIMEOUT_MS: 60_000,
} as const;
