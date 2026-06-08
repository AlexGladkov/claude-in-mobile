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

export const RECORDER = {
  PLAYBACK_MAX_STEP_TIMEOUT_MS: 30_000,
} as const;

export const SYNC = {
  BARRIER_TIMEOUT_MS: 30_000,
} as const;

export const PERFORMANCE = {
  MAX_MONITOR_DURATION_MS: 30_000,
  POLL_INTERVAL_MS: 500,
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
