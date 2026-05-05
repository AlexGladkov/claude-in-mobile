import { MobileError } from "../errors.js";

// C1: Block dangerous shell patterns
const BLOCKED_SHELL_PATTERNS = /[;|`]|&&|\|\||>\s*|>>\s*|<\s*|\$\(|\bsudo\b|\brm\s+-rf\b|\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bnetcat\b|\bdd\b|[\n\r]/i;

export function validateShellCommand(command: string): void {
  if (BLOCKED_SHELL_PATTERNS.test(command)) {
    throw new MobileError(
      "Shell command contains blocked pattern. Chaining (;|&&||), redirects (><), backticks, $() are not allowed.",
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
// Segments may start with a digit (Apple allows this in modern bundle IDs).
// AppleScript injection prevention relies on this regex — do not relax without re-auditing.
const BUNDLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9\-]*(\.[a-zA-Z0-9][a-zA-Z0-9\-]*){1,}$/;

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
    .replace(/key[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi, "key=[REDACTED]");
}
