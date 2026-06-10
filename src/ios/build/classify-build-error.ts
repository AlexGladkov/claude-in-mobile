/**
 * Classify xcodebuild / altool failures into typed errors with stable codes,
 * redacting signing identities and key-file names before anything reaches the
 * caller (LLM context = untrusted sink for secrets).
 *
 * Mapping (codes carried by the typed classes, see src/errors/asc.ts):
 *   TESTFLIGHT_SIGNING_ERROR      -> TestflightSigningError
 *   TESTFLIGHT_VERSION_COLLISION  -> TestflightVersionCollisionError
 *   ASC_AUTH_ERROR                -> AscAuthError
 *   ASC_UPLOAD_ERROR              -> AscUploadError
 */

import {
  AscAuthError,
  AscUploadError,
  MobileError,
  TestflightSigningError,
  TestflightVersionCollisionError,
} from "../../errors.js";

/** Max tail of (redacted) stderr that may appear in an error message. */
const MAX_DETAIL_CHARS = 200;

/**
 * Lines carrying signing identities or API-key material. Dropped wholesale —
 * partial redaction of "Apple Distribution: Real Name (TEAMID)" still leaks PII.
 */
const SIGNING_IDENTITY_LINE = /Apple Distribution:|Developer ID|AuthKey_|\.p8/;

/** Belt-and-suspenders token redaction for anything the line filter missed. */
const KEY_TOKEN = /(?:AuthKey_[A-Za-z0-9._-]+|\S*\.p8\b)/g;

export function redactSigningInfo(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SIGNING_IDENTITY_LINE.test(line))
    .join("\n")
    .replace(KEY_TOKEN, "[REDACTED-KEY]");
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL_CHARS ? trimmed : trimmed.slice(-MAX_DETAIL_CHARS);
}

/**
 * Map raw stderr to a typed error. Patterns match against the RAW stderr
 * (redaction may drop the very line that identifies the failure class), but
 * the resulting message only ever contains the redacted tail.
 */
export function classifyXcodeError(stderr: string, context: string): MobileError {
  const detail = tail(redactSigningInfo(stderr));

  if (/No signing certificate|CODE_SIGN/i.test(stderr)) {
    return new TestflightSigningError(
      `${context}: code signing failed. Ensure automatic signing is enabled and the ` +
        `App Store Connect API key has the App Manager role. Details: ${detail}`,
    );
  }
  if (/already been uploaded|DUPLICATE/i.test(stderr)) {
    // The collision class wants the colliding version; best-effort extraction
    // from the RAW stderr (never echoed back — only the parsed version is).
    const version = /bundle version\s+"?([\w.]+)"?/i.exec(stderr)?.[1] ?? "(unknown)";
    return new TestflightVersionCollisionError(version);
  }
  if (/Authentication credentials|401/i.test(stderr)) {
    return new AscAuthError(`${context}: ${detail}`);
  }
  if (/Missing Compliance/i.test(stderr)) {
    return new AscUploadError(
      `${context}: upload flagged "Missing Compliance". Set ` +
        `ITSAppUsesNonExemptEncryption=false in Info.plist (if you only use exempt ` +
        `encryption) or answer the export-compliance question in App Store Connect. ` +
        `Details: ${detail}`,
    );
  }
  return new AscUploadError(`${context} failed: ${detail}`);
}
