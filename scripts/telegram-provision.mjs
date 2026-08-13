#!/usr/bin/env node
/**
 * telegram-provision.mjs -- disposable test-DC userbot registration.
 *
 * Connects to the Telegram TEST data-centre ONLY (testServers: true).
 * Prints the resulting StringSession to stdout so the CI step can mask and
 * export it:
 *
 *   SESSION=$(node scripts/telegram-provision.mjs)
 *   echo "::add-mask::$SESSION"
 *   echo "TELEGRAM_STRING_SESSION=$SESSION" >> "$GITHUB_ENV"
 *
 * Security invariants:
 *   - Session is NEVER written to disk.
 *   - All GramJS output is suppressed (LogLevel.NONE) -- session never leaks
 *     via server logs or stderr.
 *   - Phone number / code are deterministic test-DC values (99966X YYYY /
 *     code = dc_id * 5). They are NOT secrets; production DCs reject them
 *     with PHONE_NUMBER_INVALID (third layer of the prod guard).
 *   - Production provisioning is structurally absent from this file. There is
 *     no code path for real user phones or prod DC registration.
 *
 * GramJS API mirrored from packages/plugin-telegram/src/gram-client.ts
 * (defaultGramDriverFactory) -- same import paths, same constructor shape,
 * same LogLevel.NONE silencing. testServers: true is added because a fresh
 * StringSession("") has no embedded DC address; without it GramJS defaults
 * to the production DC and rejects the test phone number.
 *
 * Required env: TELEGRAM_API_ID, TELEGRAM_API_HASH
 */

const apiIdRaw = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiIdRaw || !apiHash) {
  process.stderr.write(
    "[provision] ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set.\n"
  );
  process.exit(1);
}

const apiId = Number(apiIdRaw);
if (!Number.isInteger(apiId) || apiId <= 0) {
  process.stderr.write("[provision] ERROR: TELEGRAM_API_ID must be a positive integer.\n");
  process.exit(1);
}

// Disposable identity for test DC 2 (mirrors identity.ts::buildTestDcIdentity).
// Phone format: 99966 <dcId> <4-digit suffix>
// Login code:   dc_id repeated 5 times ("22222" for DC 2)
const DC_ID = 2;
const suffix = String(Math.floor(Math.random() * 10_000)).padStart(4, "0").slice(-4);
const phoneNumber = `99966${DC_ID}${suffix}`;
const phoneCode = String(DC_ID).repeat(5); // deterministic, not a secret

// Lazy GramJS imports -- same module paths used in defaultGramDriverFactory.
const tg = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");
const { Logger } = await import("telegram/extensions/index.js");
const { LogLevel } = await import("telegram/extensions/Logger.js");

const session = new StringSession(""); // empty = new registration
const client = new tg.TelegramClient(session, apiId, apiHash, {
  connectionRetries: 1,
  testServers: true,                      // connect to test DC, not production
  baseLogger: new Logger(LogLevel.NONE),  // suppress all output including session
});

await client.start({
  phoneNumber: async () => phoneNumber,
  phoneCode: async () => phoneCode,
  onError: (err) => {
    // Avoid echoing raw error text to stderr in case it contains partial auth data.
    process.stderr.write("[provision] GramJS start() failed. Check API credentials.\n");
    process.exit(1);
  },
});

// Only the session string goes to stdout. The CI step masks it before setting
// GITHUB_ENV. Nothing else is written to stdout.
process.stdout.write(client.session.save() + "\n");

await client.disconnect();
process.exit(0);
