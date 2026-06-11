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

/** Max number of extracted `error:` / `e: ` lines in the default message. */
const MAX_ERROR_LINES = 5;

/**
 * Compiler/linker error lines buried mid-log: xcodebuild `error:`, clang
 * `<file>: error:`, gradle/Kotlin `e: `. The build-system tail ("Script-*.sh
 * ... (2 failures)") is noise — these lines carry the actual cause.
 */
const ERROR_LINE_RE = /^(.*error:|e: |error: )/;

/**
 * Lines carrying signing identities or API-key material. Dropped wholesale —
 * partial redaction of "Apple Distribution: Real Name (TEAMID)" still leaks PII.
 */
const SIGNING_IDENTITY_LINE = /Apple Distribution:|Developer ID|AuthKey_|\.p8/;

/** Belt-and-suspenders token redaction for anything the line filter missed. */
const KEY_TOKEN = /(?:AuthKey_[A-Za-z0-9._-]+|\S*\.p8\b)/g;

/**
 * App Store bundle-reject patterns observed in real altool validate/upload
 * runs, with actionable recovery hints. Matched against individual validation
 * `detail :` lines (upload.ts) and against whole stderr (classifyXcodeError).
 */
export const BUNDLE_REJECT_HINTS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /LaunchScreen|UILaunchScreen/,
    hint: 'Add "UILaunchScreen": {} to Info.plist (iOS 14+) or include a LaunchScreen.storyboard',
  },
  {
    pattern: /CFBundleIconName/,
    hint:
      "Add a 1024x1024 AppIcon to Assets.xcassets and ensure CFBundleIconName is set " +
      "(Xcode does this when the asset catalog has an AppIcon)",
  },
  {
    pattern: /UISupportedInterfaceOrientations/,
    hint:
      "iPad multitasking requires all four orientations in UISupportedInterfaceOrientations, " +
      "or set UIRequiresFullScreen=true",
  },
];

/** First matching recovery hint for a bundle-reject message, if any. */
export function bundleRejectHint(text: string): string | undefined {
  return BUNDLE_REJECT_HINTS.find(({ pattern }) => pattern.test(text))?.hint;
}

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
 * Pull actual `error:` / `e: ` lines out of REDACTED stderr. Returns undefined
 * when none are present (then the caller falls back to the stderr tail).
 */
function extractErrorLines(redacted: string): string | undefined {
  const lines = redacted.split("\n").filter((line) => ERROR_LINE_RE.test(line));
  if (lines.length === 0) return undefined;
  return lines
    .slice(0, MAX_ERROR_LINES)
    .map((line) => line.trim().slice(0, MAX_DETAIL_CHARS))
    .join("\n");
}

/**
 * Map raw stderr to a typed error. Patterns match against the RAW stderr
 * (redaction may drop the very line that identifies the failure class), but
 * the resulting message only ever contains redacted content.
 */
export function classifyXcodeError(stderr: string, context: string): MobileError {
  const redacted = redactSigningInfo(stderr);
  const detail = tail(redacted);

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
  const hint = bundleRejectHint(stderr);
  if (hint) {
    return new AscUploadError(
      `${context}: bundle rejected by App Store validation. Fix: ${hint}. Details: ${detail}`,
    );
  }
  const errorLines = extractErrorLines(redacted);
  return errorLines
    ? new AscUploadError(`${context} failed:\n${errorLines}`)
    : new AscUploadError(`${context} failed: ${detail}`);
}
