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

// S1: Sanitize error messages — strip tokens, keys, and secrets
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]")
    .replace(/token[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi, "token=[REDACTED]")
    .replace(/key[=:]\s*[A-Za-z0-9\-._~+/]+=*/gi, "key=[REDACTED]");
}
