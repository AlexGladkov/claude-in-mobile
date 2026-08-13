/**
 * identity -- DC-mode resolution, credential loading, and the disposable
 * test-DC identity. This module is where the security invariants from the
 * design's "Security -- hard-requirements" section are made structural.
 *
 * Invariants enforced here:
 *
 *   - FAIL-CLOSED: the default DC is the Telegram *test* DC. Production is
 *     reachable ONLY when `TELEGRAM_ALLOW_PROD === "1"` (strict equality, not
 *     truthiness) AND a `TELEGRAM_PROD_STRING_SESSION` is present.
 *
 *   - ENV-ONLY SECRETS: api_id / api_hash / StringSession come exclusively
 *     from `process.env` (CI secrets / shell). They are NEVER accepted from a
 *     verb argument or skill input. Mirrors src/store/app-store-connect.ts.
 *
 *   - DISPOSABLE IDENTITY: the phone-number / auto-register path exists ONLY
 *     in the test-DC branch. There is no code path that takes a real user
 *     phone number, and prod never registers -- it only re-uses a
 *     pre-supplied StringSession. The blast radius of a leaked test session is
 *     bounded to a throwaway test-DC account.
 */

export type DcMode = "test" | "prod";

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

/**
 * Resolve the DC mode fail-closed. Prod requires the strict opt-in flag; any
 * other value of the env var (including "true", "1 ", "yes") keeps us on the
 * test DC.
 */
export function resolveDcMode(env: NodeJS.ProcessEnv = process.env): DcMode {
  return env.TELEGRAM_ALLOW_PROD === "1" ? "prod" : "test";
}

/** Non-secret api credentials + the (secret) StringSession, all from env. */
export interface TelegramCredentials {
  readonly apiId: number;
  readonly apiHash: string;
  readonly mode: DcMode;
  /**
   * Pre-supplied StringSession. Required for prod. Optional for test (absent
   * => the caller may auto-register a disposable identity).
   */
  readonly stringSession?: string;
}

/**
 * Load credentials from the environment ONLY. Throws `TelegramConfigError`
 * (never leaks the raw env values) when required pieces are missing.
 *
 * test DC:
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH            (required)
 *   TELEGRAM_STRING_SESSION                        (optional)
 * prod DC (only when TELEGRAM_ALLOW_PROD=1):
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH            (required)
 *   TELEGRAM_PROD_STRING_SESSION                   (required -- no auto-register)
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv = process.env,
): TelegramCredentials {
  const mode = resolveDcMode(env);

  const apiIdRaw = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;
  if (!apiIdRaw || !apiHash) {
    throw new TelegramConfigError(
      "Missing TELEGRAM_API_ID / TELEGRAM_API_HASH in environment. " +
        "Telegram credentials are read from env only (never from arguments).",
    );
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new TelegramConfigError("TELEGRAM_API_ID must be a positive integer.");
  }

  if (mode === "prod") {
    const stringSession = env.TELEGRAM_PROD_STRING_SESSION;
    if (!stringSession) {
      // Prod NEVER auto-registers: a pre-supplied session is mandatory.
      throw new TelegramConfigError(
        "prod DC requested (TELEGRAM_ALLOW_PROD=1) but TELEGRAM_PROD_STRING_SESSION " +
          "is not set. Prod has no registration path -- supply a throwaway session.",
      );
    }
    return { apiId, apiHash, mode, stringSession };
  }

  // test DC: session optional (may auto-register a disposable identity).
  return {
    apiId,
    apiHash,
    mode,
    stringSession: env.TELEGRAM_STRING_SESSION,
  };
}

/**
 * A disposable Telegram *test-DC* identity. Test DCs accept the reserved phone
 * range `99966XYYYY` where `X` is the dc id and the login code is `dcId`
 * repeated 5 times. These numbers are physically invalid on production
 * (`PHONE_NUMBER_INVALID`), which is the third layer of the prod guard.
 */
export interface TestDcIdentity {
  readonly phoneNumber: string;
  readonly phoneCode: string;
  readonly dcId: number;
}

/**
 * Build a deterministic disposable identity for a given test DC id (1..3).
 * Pure: does no I/O and performs no login. The actual `client.start` call that
 * consumes this lives behind a `mode === "test"` guard in gram-client.
 */
export function buildTestDcIdentity(
  dcId = 2,
  randomSuffix?: number,
): TestDcIdentity {
  if (!Number.isInteger(dcId) || dcId < 1 || dcId > 3) {
    throw new TelegramConfigError(`Invalid test DC id: ${dcId} (expected 1..3).`);
  }
  // 99966 <dcId> <4-digit suffix>. Suffix is cosmetic on the test DC.
  const suffix = (randomSuffix ?? Math.floor(Math.random() * 10_000))
    .toString()
    .padStart(4, "0")
    .slice(-4);
  return {
    phoneNumber: `99966${dcId}${suffix}`,
    phoneCode: String(dcId).repeat(5),
    dcId,
  };
}

/**
 * Hard guard: throws unless we are on the test DC. Call this immediately
 * before any auto-registration / phone-login code so the disposable-identity
 * path is structurally unreachable on prod.
 */
export function assertTestDcOnly(mode: DcMode, action: string): void {
  if (mode !== "test") {
    throw new TelegramConfigError(
      `Refusing to ${action} on the '${mode}' DC: auto-registration is a ` +
        `test-DC-only path. Prod requires a pre-supplied StringSession.`,
    );
  }
}
