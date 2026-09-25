import { MobileError } from "../errors.js";
import { stripTerminalControls } from "./terminal-controls.js";

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
const ALLOWED_URL_SCHEMES: Readonly<Record<string, true>> = {
  "http:": true,
  "https:": true,
  "market:": true,
  "tel:": true,
  "mailto:": true,
};

export function validateUrl(url: string): URL {
  if (url.length > 8192 || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new MobileError("Invalid URL.", "INVALID_URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MobileError("Invalid URL.", "INVALID_URL");
  }
  if (!Object.hasOwn(ALLOWED_URL_SCHEMES, parsed.protocol)) {
    throw new MobileError(
      "URL scheme not allowed. Use http:// or https://.",
      "URL_SCHEME_BLOCKED"
    );
  }
  return parsed;
}


// C3: Validate package name and permission format
const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const PERMISSION_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

export function validatePackageName(name: string): void {
  if (name.length > 255 || !PACKAGE_NAME_RE.test(name)) {
    throw new MobileError(
      "Invalid package name. Expected reverse-domain format.",
      "INVALID_PACKAGE_NAME"
    );
  }
}

export function validatePermission(perm: string): void {
  if (perm.length > 256 || !PERMISSION_RE.test(perm)) {
    throw new MobileError(
      "Invalid permission name.",
      "INVALID_PERMISSION"
    );
  }
}

// C4: Validate device ID format (alphanumeric, dots, colons, hyphens, underscores, @)
export function validateDeviceId(id: string): void {
  if (id.length > 255 || !/^[a-zA-Z0-9._:@\-]+$/.test(id) || id.startsWith("-")) {
    throw new MobileError(
      "Invalid device ID format.",
      "INVALID_DEVICE_ID"
    );
  }
}

// C5: Validate logcat tag format
export function validateLogTag(tag: string): void {
  if (tag.length > 128 || !/^[a-zA-Z0-9_.:*\-]+$/.test(tag)) {
    throw new MobileError(
      "Invalid log tag format.",
      "INVALID_LOG_TAG"
    );
  }
}

// C6: Validate logcat timestamp format
export function validateLogTimestamp(since: string): void {
  if (since.length > 64 || !/^[\d\-:\s.]+$/.test(since)) {
    throw new MobileError(
      "Invalid log timestamp format.",
      "INVALID_LOG_TIMESTAMP"
    );
  }
}

// C7: Validate JVM argument — block shell injection characters
export function validateJvmArg(arg: string): void {
  if (arg.length > 4096 || /[;|`\u0000\n\r]|&&|\|\||\$\(/.test(arg)) {
    throw new MobileError(
      "JVM argument contains dangerous characters.",
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
  if (!id || id.length > 255 || !BUNDLE_ID_RE.test(id)) {
    throw new MobileError(
      "Invalid bundleId. Expected reverse-DNS format.",
      "INVALID_BUNDLE_ID"
    );
  }
}

// A1: Validate App Store Connect key ID — exactly 10 uppercase alphanumeric chars
const ASC_KEY_ID_RE = /^[A-Z0-9]{10}$/;

export function validateAscKeyId(v: string): void {
  if (!ASC_KEY_ID_RE.test(v)) {
    throw new MobileError(
      "Invalid App Store Connect key ID.",
      "INVALID_ASC_KEY_ID"
    );
  }
}

// A2: Validate App Store Connect issuer ID — UUID format
const ASC_ISSUER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAscIssuerId(v: string): void {
  if (!ASC_ISSUER_ID_RE.test(v)) {
    throw new MobileError(
      "Invalid App Store Connect issuer ID.",
      "INVALID_ASC_ISSUER_ID"
    );
  }
}

// A3: Validate Xcode scheme name — passed to xcodebuild via argv, whitelist anyway
const XCODE_SCHEME_RE = /^[A-Za-z0-9 _.\-]{1,128}$/;

export function validateXcodeScheme(v: string): void {
  if (!XCODE_SCHEME_RE.test(v)) {
    throw new MobileError(
      "Invalid Xcode scheme or configuration.",
      "INVALID_XCODE_SCHEME"
    );
  }
}

// A4: Validate version string — 1 to 3 numeric components (e.g. "1", "1.2", "1.2.3")
const VERSION_STRING_RE = /^[0-9]+(\.[0-9]+){0,2}$/;

export function validateVersionString(v: string): void {
  if (!VERSION_STRING_RE.test(v)) {
    throw new MobileError(
      "Invalid version string. Expected 1-3 numeric components.",
      "INVALID_VERSION_STRING"
    );
  }
}

// V1: Validate baseline/screen name — whitelist regex
const BASELINE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$/;
const WINDOWS_RESERVED: Readonly<Record<string, true>> = {
  CON: true,
  PRN: true,
  AUX: true,
  NUL: true,
  COM1: true,
  COM2: true,
  COM3: true,
  COM4: true,
  COM5: true,
  COM6: true,
  COM7: true,
  COM8: true,
  COM9: true,
  LPT1: true,
  LPT2: true,
  LPT3: true,
  LPT4: true,
  LPT5: true,
  LPT6: true,
  LPT7: true,
  LPT8: true,
  LPT9: true,
};

export function validateBaselineName(name: string, label = "name"): void {
  if (!name || name.trim().length === 0 || !BASELINE_NAME_RE.test(name)) {
    throw new MobileError(`Invalid baseline ${label}.`, "INVALID_BASELINE_NAME");
  }
  const upper = name.toUpperCase().replace(/\.[^.]*$/, "");
  if (Object.hasOwn(WINDOWS_RESERVED, upper)) {
    throw new MobileError(`Invalid baseline ${label}.`, "INVALID_BASELINE_NAME");
  }
}

export function validateSandboxPath(path: string, label = "path"): void {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "..") ||
    !/^[A-Za-z0-9_./-]+$/.test(path)
  ) {
    throw new MobileError(`Invalid sandbox ${label}.`, "INVALID_SANDBOX_PATH");
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

// S1: Sanitize error messages — strip tokens, keys, and secrets.
//
// Keep the credential recognizers here (rather than in MCP code) so every
// caller that exposes an error or diagnostic string gets the same protection.
const CREDENTIAL_REDACTION = "[REDACTED]";
const AWS_ACCESS_KEY_RE =
  /\b(?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ASCA|ACCA|ABIA|A3T[A-Z0-9])[0-9A-Z]{16}\b/gu;
const AWS_SECRET_CANDIDATE_RE =
  /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gu;
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/gu;
const ANTHROPIC_TOKEN_RE = /\bsk-ant-[A-Za-z0-9_-]+/gu;
const OPENAI_TOKEN_RE = /\bsk-[A-Za-z0-9_-]+/gu;
const GOOGLE_API_KEY_RE = /\bAIza[A-Za-z0-9_-]+/gu;
const SLACK_TOKEN_RE = /\bxox[A-Za-z0-9]*-[A-Za-z0-9-]+/gu;
const JWT_RE = /\beyJ[A-Za-z0-9._-]+/gu;
const URI_SENSITIVE_QUERY_KEY_RE =
  /(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|authorization|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|jwt|(?:^|[_-])(?:pin|otp)(?:$|[_-]|code|number|value)|one[_-]?time[_-]?code|verification[_-]?code|security[_-]?code|cvv|cvc|(?:^|[_-])(?:code|state)(?:$|[_-])|oauth[_-]?code|authorization[_-]?code|^key$)/iu;
function normalizeSanitizedText(value: string): string {
  const withoutTerminalControls = stripTerminalControls(value);
  const normalized = withoutTerminalControls.replace(/\r\n?/g, "\n");
  return normalized.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}


function redactCredentialText(value: string): string {
  return normalizeSanitizedText(value)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s?#]*@/giu, "$1")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED_KEY]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/giu, "$1 [REDACTED]")
    .replace(
      /(["']?\b(?:access[_-]?token|refresh[_-]?token|jwtToken|api[_-]?key|client[_-]?secret|password|passwd|secret|authorization|credentials?|private[_-]?key|token|key|code|state|oauth[_-]?code|authorization[_-]?code|(?:[A-Za-z0-9_-]+[_-])?(?:pin|otp)(?:[_-]?(?:code|value|number))?|one[_-]?time[_-]?code|verification[_-]?code|security[_-]?code|cvv|cvc|credit[_-]?card[_-]?(?:number|code)|card[_-]?number)\b["']?\s*:\s*)"((?:\\.|[^"\\])*)"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /(["']?\b(?:access[_-]?token|refresh[_-]?token|jwtToken|api[_-]?key|client[_-]?secret|password|passwd|secret|authorization|credentials?|private[_-]?key|token|key|code|state|oauth[_-]?code|authorization[_-]?code|(?:[A-Za-z0-9_-]+[_-])?(?:pin|otp)(?:[_-]?(?:code|value|number))?|one[_-]?time[_-]?code|verification[_-]?code|security[_-]?code|cvv|cvc|credit[_-]?card[_-]?(?:number|code)|card[_-]?number)\b["']?\s*:\s*)'((?:\\.|[^'\\])*)'/giu,
      "$1'[REDACTED]'",
    )
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|jwtToken|api[_-]?key|client[_-]?secret|password|passwd|secret|authorization|credentials?|private[_-]?key|token|key|code|state|oauth[_-]?code|authorization[_-]?code|(?:[A-Za-z0-9_-]+[_-])?(?:pin|otp)(?:[_-]?(?:code|value|number))?|one[_-]?time[_-]?code|verification[_-]?code|security[_-]?code|cvv|cvc|credit[_-]?card[_-]?(?:number|code)|card[_-]?number)\b\s*[=:]\s*(?!Bearer\b|Basic\b)[^\s,'"}]+/giu,
      "$1=[REDACTED]",
    )
    .replace(AWS_ACCESS_KEY_RE, CREDENTIAL_REDACTION)
    .replace(AWS_SECRET_CANDIDATE_RE, CREDENTIAL_REDACTION)
    .replace(GITHUB_TOKEN_RE, CREDENTIAL_REDACTION)
    .replace(ANTHROPIC_TOKEN_RE, CREDENTIAL_REDACTION)
    .replace(OPENAI_TOKEN_RE, CREDENTIAL_REDACTION)
    .replace(GOOGLE_API_KEY_RE, CREDENTIAL_REDACTION)
    .replace(SLACK_TOKEN_RE, CREDENTIAL_REDACTION)
    .replace(JWT_RE, "[REDACTED_JWT]");
}

function containsCredentialMaterial(value: string): boolean {
  return redactCredentialText(value) !== value;
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function filterUriQuery(rawQuery: string): { query: string; changed: boolean } {
  if (!rawQuery) return { query: rawQuery, changed: false };

  let changed = false;
  const safeSegments: string[] = [];
  for (const segment of rawQuery.split("&")) {
    if (segment.length === 0) {
      safeSegments.push(segment);
      continue;
    }
    const separator = segment.indexOf("=");
    const encodedKey = separator >= 0 ? segment.slice(0, separator) : segment;
    const encodedValue = separator >= 0 ? segment.slice(separator + 1) : "";
    const key = decodeUriComponentSafely(encodedKey);
    const queryValue = decodeUriComponentSafely(encodedValue);
    if (
      URI_SENSITIVE_QUERY_KEY_RE.test(key)
      || containsCredentialMaterial(key)
      || containsCredentialMaterial(queryValue)
      || containsCredentialMaterial(`${key}=${queryValue}`)
    ) {
      changed = true;
      continue;
    }
    safeSegments.push(segment);
  }
  return { query: safeSegments.join("&"), changed };
}

function stripRawUriUserinfo(uri: string): { value: string; changed: boolean } {
  const authority = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/u.exec(uri);
  if (!authority) return { value: uri, changed: false };

  const at = authority[2].lastIndexOf("@");
  if (at < 0) return { value: uri, changed: false };
  return {
    value: `${authority[1] ?? ""}//${authority[2].slice(at + 1)}${authority[3]}`,
    changed: true,
  };
}

// URI fields are textual MCP egresses, but blindly applying URL normalization
// would change ordinary resource identifiers. Preserve safe input verbatim;
// only strip userinfo and credential-bearing query/fragment components.
export function sanitizeResourceUri(value: unknown, maxChars = 8_192): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = normalizeSanitizedText(value.slice(0, maxChars));
  let candidate = normalized;
  let changed = false;
  let parsed: URL | undefined;
  try {
    parsed = new URL(normalized);
  } catch {
    // MCP permits non-URL resource identifiers. The fallback below handles
    // their query, fragment, and authority components without rejecting safe
    // custom schemes or relative identifiers.
  }

  if (parsed) {
    const hasUserinfo = parsed.username.length > 0
      || parsed.password.length > 0
      || /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/?#]*@/u.test(normalized);
    if (hasUserinfo) {
      parsed.username = "";
      parsed.password = "";
      changed = true;
    }

    const filteredQuery = filterUriQuery(parsed.search.slice(1));
    if (filteredQuery.changed) {
      parsed.search = filteredQuery.query ? `?${filteredQuery.query}` : "";
      changed = true;
    }

    if (parsed.hash) {
      const fragment = decodeUriComponentSafely(parsed.hash.slice(1));
      if (containsCredentialMaterial(fragment)) {
        parsed.hash = "";
        changed = true;
      }
    }

    const decodedPath = decodeUriComponentSafely(parsed.pathname);
    if (containsCredentialMaterial(decodedPath)) return undefined;
    if (changed) candidate = parsed.toString();
  } else {
    const stripped = stripRawUriUserinfo(candidate);
    candidate = stripped.value;
    changed = stripped.changed;

    const fragmentIndex = candidate.indexOf("#");
    if (fragmentIndex >= 0) {
      const fragment = decodeUriComponentSafely(candidate.slice(fragmentIndex + 1));
      if (containsCredentialMaterial(fragment)) {
        candidate = candidate.slice(0, fragmentIndex);
        changed = true;
      }
    }

    const queryIndex = candidate.indexOf("?");
    if (queryIndex >= 0) {
      const filteredQuery = filterUriQuery(candidate.slice(queryIndex + 1));
      if (filteredQuery.changed) {
        candidate = `${candidate.slice(0, queryIndex)}${
          filteredQuery.query ? `?${filteredQuery.query}` : ""
        }`;
        changed = true;
      }
    }

    const pathEnd = candidate.search(/[?#]/u);
    const decodedPath = decodeUriComponentSafely(
      pathEnd >= 0 ? candidate.slice(0, pathEnd) : candidate,
    );
    if (containsCredentialMaterial(decodedPath)) return undefined;
  }

  if (candidate.length === 0 && normalized.length > 0) return undefined;

  // Redact credentials in non-standard URI paths/hosts as a final defense,
  // while retaining ordinary URI text exactly when no sensitive material exists.
  const redacted = redactCredentialText(candidate);
  return redacted.slice(0, maxChars);
}

export function sanitizeErrorMessage(value: unknown): string {
  const message = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : "Unknown error";
  return redactCredentialText(message.slice(0, 64 * 1024)).slice(0, 4096);
}
