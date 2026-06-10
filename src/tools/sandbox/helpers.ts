import { ValidationError } from "../../errors.js";
import { z } from "../define-tool.js";

/** Validates a database filename: only alphanumeric, dots, hyphens, underscores. */
export function validateDatabaseName(db: string): void {
  if (!/^[a-zA-Z0-9._\-]+$/.test(db)) {
    throw new ValidationError(
      `Invalid database name: "${db}". Use alphanumeric characters, dots, hyphens, or underscores only.`,
    );
  }
}

/** Validates a SQL query — only SELECT, PRAGMA, .tables, .schema are allowed. */
export function validateSqlQuery(query: string): void {
  const trimmed = query.trim();

  // Block multi-statement SQL (semicolon followed by non-whitespace)
  if (/;[^\s]/.test(trimmed) || /;\s+\S/.test(trimmed)) {
    throw new ValidationError(
      "SQL multi-statement queries are not allowed. Use a single SELECT/PRAGMA statement.",
    );
  }

  // Allow only safe read-only operations
  const upper = trimmed.toUpperCase();
  const allowed =
    upper.startsWith("SELECT ") ||
    upper.startsWith("SELECT\t") ||
    upper.startsWith("SELECT\n") ||
    upper === "SELECT" ||
    upper.startsWith("PRAGMA ") ||
    upper.startsWith("PRAGMA\t") ||
    upper === "PRAGMA" ||
    trimmed.startsWith(".tables") ||
    trimmed.startsWith(".schema") ||
    trimmed.startsWith(".indexes") ||
    trimmed.startsWith(".dump");

  if (!allowed) {
    throw new ValidationError(
      "Only SELECT and PRAGMA queries are allowed for safety. Write operations are not supported.",
    );
  }
}

/**
 * Detects likely binary content by scanning the first 512 bytes for NUL chars
 * or a high ratio of non-printable bytes.
 */
export function looksLikeBinary(text: string): boolean {
  const sample = text.slice(0, 512);
  // NUL byte is a strong binary indicator
  if (sample.includes("\x00")) return true;
  // Count non-printable, non-whitespace control chars
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 0x09 || (code > 0x0d && code < 0x20)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

/** Returns a human-readable "run-as not available" hint. */
export function runAsUnavailableHint(pkg: string): string {
  return (
    `run-as failed for package "${pkg}". ` +
    "This typically means:\n" +
    "  1. The app is not debuggable (release build without debuggable:true in manifest).\n" +
    "  2. The device is a user build (not eng/userdebug).\n" +
    "  3. The package is not installed on the device.\n\n" +
    "To enable: set android:debuggable=\"true\" in AndroidManifest.xml and rebuild, " +
    "or use an emulator / userdebug device."
  );
}

/** Checks whether output looks like a run-as failure. */
export function isRunAsFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("run-as: package not found") ||
    lower.includes("run-as: unknown package") ||
    lower.includes("run-as: error") ||
    lower.includes("package 'com") && lower.includes("is not debuggable") ||
    lower.includes("is not debuggable") ||
    lower.includes("not an application package")
  );
}

// Sandbox-specific platform enum: same values as the shared one, but with a
// custom description explaining the Android-only behaviour.
export const androidPlatformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional()
  .describe("Target platform. Sandbox access is Android-only.");
