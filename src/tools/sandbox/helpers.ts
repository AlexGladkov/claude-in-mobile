import { ValidationError } from "../../errors.js";
import { z } from "../define-tool.js";

/** Validates a database filename. */
export function validateDatabaseName(db: string): void {
  if (
    db.length > 255 ||
    db === "." ||
    db === ".." ||
    !/^[a-zA-Z0-9._-]+$/.test(db)
  ) {
    throw new ValidationError("Invalid database name.");
  }
}

const READ_ONLY_PRAGMAS: Readonly<Record<string, true>> = {
  collation_list: true,
  compile_options: true,
  database_list: true,
  foreign_key_check: true,
  foreign_key_list: true,
  freelist_count: true,
  index_info: true,
  index_list: true,
  index_xinfo: true,
  page_size: true,
  integrity_check: true,
  page_count: true,
  quick_check: true,
  schema_version: true,
  table_info: true,
  table_list: true,
  table_xinfo: true,
  user_version: true,
};

/** Validates a single read-only SQLite CLI query. */
export function validateSqlQuery(query: string): void {
  if (query.length === 0 || query.length > 8192 || query.includes("\0")) {
    throw new ValidationError("Invalid SQL query.");
  }
  const statement = query.trim().replace(/;$/, "").trim();
  if (statement.includes(";")) {
    throw new ValidationError("SQL multi-statement queries are not allowed.");
  }
  if (/\b(?:load_extension|readfile|writefile)\s*\(/i.test(statement)) {
    throw new ValidationError("Unsafe SQLite functions are not allowed.");
  }
  if (/^SELECT(?:\s|$)/i.test(statement)) return;
  if (/^\.(?:tables|schema|indexes)(?:\s+[A-Za-z0-9_.-]+)?$/i.test(statement)) return;

  const pragma = statement.match(
    /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*\([^;]*\))?$/i,
  );
  if (pragma?.[1] && Object.hasOwn(READ_ONLY_PRAGMAS, pragma[1].toLowerCase())) return;
  throw new ValidationError("Only read-only SELECT, PRAGMA, and schema queries are allowed.");
}

export function validatePreferenceName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  ) {
    throw new ValidationError("Invalid SharedPreferences file name.");
  }
}

export function validatePreferenceKey(value: string): void {
  if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new ValidationError("Invalid SharedPreferences key.");
  }
}

export function validatePreferenceValue(
  value: string,
  type: "string" | "int" | "bool" | "float" | "long",
): void {
  if (
    value.length > 16_384 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ValidationError("Invalid SharedPreferences value.");
  }
  if (type === "bool" && value !== "true" && value !== "false") {
    throw new ValidationError("Boolean preference values must be true or false.");
  }
  if ((type === "int" || type === "long") && !/^-?\d+$/.test(value)) {
    throw new ValidationError("Integer preference value is invalid.");
  }
  if (type === "float" && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new ValidationError("Float preference value is invalid.");
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
  .enum(["android", "ios", "desktop", "aurora", "harmony", "browser"])
  .optional()
  .describe("Target platform. Sandbox access is Android-only.");
