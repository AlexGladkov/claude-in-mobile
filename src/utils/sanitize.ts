import { MobileError } from "../errors.js";

// C1: Block dangerous shell patterns.
//
// SECURITY NOTE — this denylist is DEFENSE IN DEPTH. The primary protection against
// host-side OS Command Injection (CWE-78) is that ADB invocations now run through
// execFileSync(adb, argv) — see src/adb/client.ts. Even if a future regression brings
// back string-form exec, this denylist must block the obvious bypasses:
//   - standalone `&` (background separator — POSIX-equivalent of `;` for injection)
//   - process substitution `<(...)` / `>(...)`
//   - brace expansion `${...}` (parameter substitution)
//   - tab character (token-separator like space, can join attacker-controlled segments)
// Track every published bypass against this list — denylists must grow over time.
const BLOCKED_SHELL_PATTERNS =
  /[;|`&]|&&|\|\||>\s*|>>\s*|<\s*|\$\(|\$\{|<\(|>\(|\bsudo\b|\brm\s+-rf\b|\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bnetcat\b|\bdd\b|[\n\r\t]/i;

// LLM-friendly diagnostic — identify which token tripped the denylist and
// suggest the canonical MCP tool that solves the underlying task. Ordered by
// specificity (most distinctive patterns first).
const PATTERN_DIAGNOSTICS: Array<{ re: RegExp; label: string; hint: string }> = [
  { re: /&&/, label: "'&&' (AND chaining)", hint: "Invoke this tool separately for each command." },
  { re: /\|\|/, label: "'||' (OR chaining)", hint: "Invoke this tool separately and check the result in your own logic." },
  { re: /\$\(/, label: "'$(...)' (command substitution)", hint: "Inline the value or fetch it via a prior tool call." },
  { re: /\$\{/, label: "'${...}' (variable expansion)", hint: "Inline the literal value — the shell here does not expand variables." },
  { re: /<\(/, label: "'<(...)' (process substitution)", hint: "Not supported on Android shell. Save to a file and read it back." },
  { re: />\(/, label: "'>(...)' (process substitution)", hint: "Not supported on Android shell." },
  { re: /`/, label: "backtick (command substitution)", hint: "Use $() if you must — but this denylist blocks both." },
  { re: /\t/, label: "TAB character", hint: "Often comes from copy-pasting formatted text. Replace tabs with single spaces." },
  { re: /[\n\r]/, label: "newline / carriage return", hint: "Multi-line commands are not allowed. Invoke this tool once per line." },
  { re: /;/, label: "';' (statement separator)", hint: "Invoke this tool separately for each command. For URLs with ';', use system_open_url." },
  { re: /&/, label: "'&' (background / separator)", hint: "Do NOT chain commands. For URLs with '&' in query (e.g. ?a=1&b=2), use system_open_url instead of system_shell." },
  { re: /\|/, label: "'|' (pipe)", hint: "Run the producer command, capture its output, then process in your next tool call." },
  { re: />>\s*/, label: "'>>' (append redirect)", hint: "Use ui_input or app-specific tools to write data, not shell redirects." },
  { re: />\s*/, label: "'>' (redirect)", hint: "Use ui_input or app-specific tools to write data, not shell redirects." },
  { re: /<\s*/, label: "'<' (input redirect)", hint: "Read the file via system_logs or shell `cat <file>` (without the redirect symbol)." },
  { re: /\bsudo\b/i, label: "'sudo'", hint: "Android shell has no sudo. Use 'su' on rooted devices if needed (separate session)." },
  { re: /\brm\s+-rf\b/i, label: "'rm -rf'", hint: "Destructive recursive delete is blocked. Delete specific files explicitly." },
  { re: /\b(curl|wget)\b/i, label: "network downloader (curl/wget)", hint: "Use system_open_url for URLs, or transfer files via adb push." },
  { re: /\b(nc|ncat|netcat)\b/i, label: "netcat", hint: "Network shells are blocked." },
  { re: /\bdd\b/i, label: "'dd'", hint: "Use targeted tools (e.g. system_logs, app_install) instead of raw block copy." },
];

function diagnoseShellRejection(command: string): { label: string; hint: string } {
  for (const { re, label, hint } of PATTERN_DIAGNOSTICS) {
    if (re.test(command)) return { label, hint };
  }
  return { label: "shell metacharacter", hint: "Remove the offending character and retry." };
}

export function validateShellCommand(command: string): void {
  if (BLOCKED_SHELL_PATTERNS.test(command)) {
    const { label, hint } = diagnoseShellRejection(command);
    throw new MobileError(
      `Shell command rejected: blocked pattern ${label}. ${hint} ` +
        "Other options: ui_tap/ui_swipe for input, app_launch for apps, " +
        "system_open_url for URLs. Note: shell metachars in tool arguments are " +
        "treated as literals (no /bin/sh involved) — chaining will not work.",
      "SHELL_INJECTION_BLOCKED"
    );
  }
}

// C2: Validate URL scheme
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "market:", "tel:", "mailto:"]);

export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MobileError(`Invalid URL: ${url}`, "INVALID_URL");
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new MobileError(
      `URL scheme "${parsed.protocol}" not allowed. Use http:// or https://.`,
      "URL_SCHEME_BLOCKED"
    );
  }
  return parsed;
}

export function sanitizeForShell(value: string): string {
  return value.replace(/[`$\\!#&|;(){}<>]/g, "");
}

// C3: Validate package name and permission format
const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const PERMISSION_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

export function validatePackageName(name: string): void {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new MobileError(
      `Invalid package name: "${name}". Expected format: com.example.app`,
      "INVALID_PACKAGE_NAME"
    );
  }
}

export function validatePermission(perm: string): void {
  if (!PERMISSION_RE.test(perm)) {
    throw new MobileError(
      `Invalid permission: "${perm}". Expected format: android.permission.CAMERA`,
      "INVALID_PERMISSION"
    );
  }
}

// C4: Validate device ID format (alphanumeric, dots, colons, hyphens, underscores, @)
export function validateDeviceId(id: string): void {
  if (!/^[a-zA-Z0-9._:@\-]+$/.test(id)) {
    throw new MobileError(
      `Invalid device ID format: ${id}`,
      "INVALID_DEVICE_ID"
    );
  }
}

// C5: Validate logcat tag format
export function validateLogTag(tag: string): void {
  if (!/^[a-zA-Z0-9_.:*\-]+$/.test(tag)) {
    throw new MobileError(
      `Invalid log tag format: ${tag}`,
      "INVALID_LOG_TAG"
    );
  }
}

// C6: Validate logcat timestamp format
export function validateLogTimestamp(since: string): void {
  if (!/^[\d\-:\s.]+$/.test(since)) {
    throw new MobileError(
      `Invalid log timestamp format: ${since}`,
      "INVALID_LOG_TIMESTAMP"
    );
  }
}

// C7: Validate JVM argument — block shell injection characters
export function validateJvmArg(arg: string): void {
  if (/[;|`\n\r]|&&|\|\||\$\(/.test(arg)) {
    throw new MobileError(
      `JVM argument contains dangerous characters: ${arg}`,
      "INVALID_JVM_ARG"
    );
  }
}

// H1: Block path traversal
export function validatePath(path: string, label: string): void {
  if (path.includes("..")) {
    throw new MobileError(
      `Path traversal blocked in ${label}: paths must not contain ".."`,
      "PATH_TRAVERSAL_BLOCKED"
    );
  }
}

// C8: Validate macOS bundle ID (reverse-DNS format)
// Only [a-zA-Z0-9.-] allowed — safe to embed in AppleScript; passed via argv in practice.
// First character of each segment must be a letter (reverse-DNS convention).
// AppleScript injection prevention relies on this regex — do not relax without re-auditing.
const BUNDLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9\-]*(\.[a-zA-Z][a-zA-Z0-9\-]*){1,}$/;

export function validateBundleId(id: string): void {
  if (!id || id.length > 255) {
    throw new MobileError(
      `Invalid bundleId length: must be 1-255 characters`,
      "INVALID_BUNDLE_ID"
    );
  }
  if (!BUNDLE_ID_RE.test(id)) {
    throw new MobileError(
      `Invalid bundleId: "${id}". Expected reverse-DNS format (e.g. com.apple.TextEdit)`,
      "INVALID_BUNDLE_ID"
    );
  }
}

// A1: Validate App Store Connect key ID — exactly 10 uppercase alphanumeric chars
const ASC_KEY_ID_RE = /^[A-Z0-9]{10}$/;

export function validateAscKeyId(v: string): void {
  if (!ASC_KEY_ID_RE.test(v)) {
    throw new MobileError(
      `Invalid ASC key ID: "${v}". Expected 10 uppercase alphanumeric characters (e.g. 2X9R4HXF34)`,
      "INVALID_ASC_KEY_ID"
    );
  }
}

// A2: Validate App Store Connect issuer ID — UUID format
const ASC_ISSUER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAscIssuerId(v: string): void {
  if (!ASC_ISSUER_ID_RE.test(v)) {
    throw new MobileError(
      `Invalid ASC issuer ID: "${v}". Expected UUID format (e.g. 69a6de70-03db-47e3-e053-5b8c7c11a4d1)`,
      "INVALID_ASC_ISSUER_ID"
    );
  }
}

// A3: Validate Xcode scheme name — passed to xcodebuild via argv, whitelist anyway
const XCODE_SCHEME_RE = /^[A-Za-z0-9 _.\-]{1,128}$/;

export function validateXcodeScheme(v: string): void {
  if (!XCODE_SCHEME_RE.test(v)) {
    throw new MobileError(
      `Invalid Xcode scheme: "${v}". Use letters, digits, spaces, underscores, dots, hyphens. 1-128 chars.`,
      "INVALID_XCODE_SCHEME"
    );
  }
}

// A4: Validate version string — 1 to 3 numeric components (e.g. "1", "1.2", "1.2.3")
const VERSION_STRING_RE = /^[0-9]+(\.[0-9]+){0,2}$/;

export function validateVersionString(v: string): void {
  if (!VERSION_STRING_RE.test(v)) {
    throw new MobileError(
      `Invalid version string: "${v}". Expected 1-3 numeric components (e.g. 1.2.3)`,
      "INVALID_VERSION_STRING"
    );
  }
}

// V1: Validate baseline/screen name — whitelist regex
const BASELINE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$/;
const WINDOWS_RESERVED = new Set(["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"]);

export function validateBaselineName(name: string, label = "name"): void {
  if (!name || name.trim().length === 0) {
    throw new MobileError(`Baseline ${label} must not be empty`, "INVALID_BASELINE_NAME");
  }
  if (!BASELINE_NAME_RE.test(name)) {
    throw new MobileError(
      `Invalid baseline ${label}: "${name}". Use alphanumeric, hyphens, underscores, dots. 1-128 chars, start with alphanumeric.`,
      "INVALID_BASELINE_NAME"
    );
  }
  const upper = name.toUpperCase().replace(/\.[^.]*$/, "");
  if (WINDOWS_RESERVED.has(upper)) {
    throw new MobileError(`Baseline ${label} "${name}" is a reserved name`, "INVALID_BASELINE_NAME");
  }
}

// V2: Ensure resolved path stays within allowed base directory
import { resolve, sep } from "path";

export function validatePathContainment(filePath: string, baseDir: string): void {
  const normalizedBase = resolve(baseDir);
  const normalizedPath = resolve(filePath);
  if (!normalizedPath.startsWith(normalizedBase + sep) && normalizedPath !== normalizedBase) {
    throw new MobileError(
      "Path escape blocked: resolved path is outside allowed directory",
      "PATH_CONTAINMENT_VIOLATION"
    );
  }
}

// S1: Sanitize error messages — strip tokens, keys, and secrets
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]")
    .replace(/token[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi, "token=[REDACTED]")
    .replace(/key[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi, "key=[REDACTED]")
    // Standalone JWTs (header always base64url-encodes '{"' as "eyJ")
    .replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED_JWT]");
}
