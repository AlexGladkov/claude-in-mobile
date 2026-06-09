import type { ToolDefinition } from "./registry.js";
import { validatePackageName, validatePath, sanitizeForShell } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { defineTool, z } from "./define-tool.js";
import { deviceIdField } from "./common-schema.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult, errorResult } from "../utils/tool-result.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validates a database filename: only alphanumeric, dots, hyphens, underscores. */
function validateDatabaseName(db: string): void {
  if (!/^[a-zA-Z0-9._\-]+$/.test(db)) {
    throw new ValidationError(
      `Invalid database name: "${db}". Use alphanumeric characters, dots, hyphens, or underscores only.`,
    );
  }
}

/** Validates a SQL query — only SELECT, PRAGMA, .tables, .schema are allowed. */
function validateSqlQuery(query: string): void {
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
function looksLikeBinary(text: string): boolean {
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
function runAsUnavailableHint(pkg: string): string {
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
function isRunAsFailure(output: string): boolean {
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
const androidPlatformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional()
  .describe("Target platform. Sandbox access is Android-only.");

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const sandboxTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // sandbox_prefs_read
  // -------------------------------------------------------------------------
  defineTool({
    name: "sandbox_prefs_read",
    description:
      "Read SharedPreferences XML from an app's private sandbox via adb run-as. " +
      "Parses the XML and returns a formatted key-value list. " +
      "If no file is specified, lists all available preference files first. " +
      "Only works on debuggable apps or userdebug/eng device builds.",
    schema: z.object({
      package: z.string().describe("App package name, e.g. com.example.app"),
      file: z
        .string()
        .optional()
        .describe(
          'SharedPreferences file name without .xml extension, e.g. "preferences" or "user_settings". ' +
            "If omitted, lists available files.",
        ),
      platform: androidPlatformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return errorResult("sandbox_prefs_read is only available on Android.");
      }

      const pkg = args.package;
      validatePackageName(pkg);

      // No file specified — list available preference files first.
      if (!args.file) {
        let listOutput: string;
        try {
          listOutput = ctx.deviceManager.shell(`run-as ${pkg} ls shared_prefs/`, "android", deviceId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
          return errorResult(`Failed to list shared_prefs: ${msg}`);
        }

        if (isRunAsFailure(listOutput)) return errorResult(runAsUnavailableHint(pkg));

        const files = listOutput
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.endsWith(".xml"));

        if (files.length === 0) {
          return textResult(`No SharedPreferences files found for "${pkg}".`);
        }

        return textResult(
          `Available SharedPreferences files for "${pkg}":\n` +
            files.map(f => `  - ${f.replace(/\.xml$/, "")}`).join("\n") +
            "\n\nRe-run with file:<name> to read a specific file.",
        );
      }

      // Validate and sanitize the file name.
      const rawFile = args.file;
      validatePath(rawFile, "file");
      const safeFile = sanitizeForShell(rawFile);
      if (safeFile.length === 0) {
        return errorResult("Invalid file name after sanitization.");
      }

      let xmlContent: string;
      try {
        xmlContent = ctx.deviceManager.shell(`run-as ${pkg} cat shared_prefs/${safeFile}.xml`, "android", deviceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
        return errorResult(`Failed to read preferences: ${msg}`);
      }

      if (isRunAsFailure(xmlContent)) return errorResult(runAsUnavailableHint(pkg));
      if (!xmlContent || xmlContent.trim().length === 0) {
        return textResult(`File "shared_prefs/${safeFile}.xml" is empty or does not exist.`);
      }

      // Parse key-value pairs from Android SharedPreferences XML.
      // Supports <string>, <int>, <long>, <float>, <boolean>, <set> tags.
      const entries: string[] = [];
      const tagRe =
        /<(string|int|long|float|boolean|set)\s+name="([^"]+)"(?:\s+value="([^"]*)")?(?:\s*>([^<]*)<\/\1>|\s*\/>)/g;
      let match: RegExpExecArray | null;

      while ((match = tagRe.exec(xmlContent)) !== null) {
        const type = match[1];
        const name = match[2];
        const attrValue = match[3];
        const innerText = match[4]?.trim();

        let displayValue: string;
        if (type === "string") {
          displayValue = `"${innerText ?? ""}"`;
        } else if (type === "set") {
          // <set> contains multiple <string> children
          const items = Array.from((innerText ?? "").matchAll(/<string>([^<]*)<\/string>/g)).map(
            m => m[1],
          );
          displayValue = `[${items.map(s => `"${s}"`).join(", ")}]`;
        } else {
          displayValue = attrValue ?? innerText ?? "(empty)";
        }

        entries.push(`  ${name} (${type}) = ${displayValue}`);
      }

      if (entries.length === 0) {
        // Return raw XML if parsing yielded nothing (unusual format).
        return textResult(
          `No parseable entries found in "${safeFile}.xml". Raw content:\n\n${truncateOutput(xmlContent, { maxChars: 5000 })}`,
        );
      }

      return textResult(
        `SharedPreferences: "${pkg}" / "${safeFile}.xml"\n` +
          `${entries.length} entries:\n\n` +
          entries.join("\n"),
      );
    },
  }),

  // -------------------------------------------------------------------------
  // sandbox_prefs_write
  // -------------------------------------------------------------------------
  defineTool({
    name: "sandbox_prefs_write",
    description:
      "Write or update a single value in an app's SharedPreferences XML via adb run-as. " +
      "Uses sed to replace the target key in-place inside the XML file. " +
      "The app must be restarted after writing for changes to take effect. " +
      "Only works on debuggable apps or userdebug/eng device builds.",
    schema: z.object({
      package: z.string().describe("App package name, e.g. com.example.app"),
      file: z
        .string()
        .describe('SharedPreferences file name without .xml extension, e.g. "preferences"'),
      key: z.string().describe("Preference key to write"),
      value: z.string().describe("New value to set"),
      type: z
        .enum(["string", "int", "bool", "float", "long"])
        .optional()
        .describe("Value type (default: string). Determines the XML element tag used."),
      platform: androidPlatformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return errorResult("sandbox_prefs_write is only available on Android.");
      }

      const pkg = args.package;
      validatePackageName(pkg);

      const rawFile = args.file;
      validatePath(rawFile, "file");
      const safeFile = sanitizeForShell(rawFile);
      if (safeFile.length === 0) {
        return errorResult("Invalid file name after sanitization.");
      }

      const rawKey = args.key;
      const safeKey = sanitizeForShell(rawKey);
      if (safeKey.length === 0) {
        return errorResult("Invalid key after sanitization.");
      }

      const rawValue = args.value;
      const safeValue = sanitizeForShell(rawValue);

      const type = args.type ?? "string";

      const xmlPath = `shared_prefs/${safeFile}.xml`;

      // Build sed replacement pattern based on type.
      // <string name="key">value</string>  — string type (value in inner text)
      // <int name="key" value="123" />     — numeric/bool types (value in attribute)
      let sedCmd: string;
      if (type === "string") {
        sedCmd =
          `run-as ${pkg} sed -i ` +
          `'s|<string name="${safeKey}">[^<]*</string>|<string name="${safeKey}">${safeValue}</string>|' ` +
          xmlPath;
      } else {
        // int / long / float / bool all use value="..." attribute form
        const xmlTag = type === "bool" ? "boolean" : type;
        sedCmd =
          `run-as ${pkg} sed -i ` +
          `'s|<${xmlTag} name="${safeKey}" value="[^"]*" />|<${xmlTag} name="${safeKey}" value="${safeValue}" />|' ` +
          xmlPath;
      }

      let output: string;
      try {
        output = ctx.deviceManager.shell(sedCmd, "android", deviceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
        return errorResult(`Failed to write preference: ${msg}`);
      }

      if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

      return textResult(
        `Preference updated in "${pkg}" / "${safeFile}.xml":\n` +
          `  key   = ${safeKey}\n` +
          `  value = ${safeValue}\n` +
          `  type  = ${type}\n\n` +
          "NOTE: The app must be restarted for the change to take effect. " +
          "Use app(action:'restart', package:'<pkg>') or force-stop and relaunch.",
      );
    },
  }),

  // -------------------------------------------------------------------------
  // sandbox_sqlite_query
  // -------------------------------------------------------------------------
  defineTool({
    name: "sandbox_sqlite_query",
    description:
      "Run a read-only SQL query against an app's SQLite database via adb run-as + sqlite3. " +
      "Supports SELECT and PRAGMA queries. Write operations are blocked. " +
      "Only works on debuggable apps or userdebug/eng device builds.",
    schema: z.object({
      package: z.string().describe("App package name, e.g. com.example.app"),
      database: z.string().describe('Database filename, e.g. "app.db" or "mydata.sqlite"'),
      query: z.string().describe("SQL query to execute. Only SELECT and PRAGMA are allowed."),
      platform: androidPlatformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return errorResult("sandbox_sqlite_query is only available on Android.");
      }

      const pkg = args.package;
      validatePackageName(pkg);

      const rawDb = args.database;
      validateDatabaseName(rawDb);

      const query = args.query;
      validateSqlQuery(query);

      // Sanitize the query for safe shell quoting (single-quote based).
      // Escape single quotes inside the query by ending the string, adding \',
      // then starting a new string: ' -> '\''
      const shellSafeQuery = query.replace(/'/g, "'\\''");

      const dbRelPath = `databases/${rawDb}`;
      const dbAbsPath = `/data/data/${pkg}/databases/${rawDb}`;

      // Try relative path via run-as first; fall back to absolute path.
      let output: string | undefined;
      let lastError = "";

      for (const dbPath of [dbRelPath, dbAbsPath]) {
        try {
          output = ctx.deviceManager.shell(`run-as ${pkg} sqlite3 ${dbPath} '${shellSafeQuery}'`, "android", deviceId);
          if (!isRunAsFailure(output)) break;
          // Treat run-as failure from the relative path attempt and try absolute.
          lastError = output;
          output = undefined;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (isRunAsFailure(lastError)) {
            return errorResult(runAsUnavailableHint(pkg));
          }
          // sqlite3 might not be found on the device — provide helpful message.
          if (lastError.toLowerCase().includes("not found") || lastError.toLowerCase().includes("no such file")) {
            return errorResult(
              `sqlite3 is not available on this device or the database file was not found.\n\n` +
                `Tried paths:\n  ${dbRelPath}\n  ${dbAbsPath}\n\n` +
                "sqlite3 is pre-installed on most Android emulators but may be absent on physical devices.\n" +
                `Error: ${lastError}`,
            );
          }
          // Continue to try the next path.
        }
      }

      if (!output) {
        if (isRunAsFailure(lastError)) return errorResult(runAsUnavailableHint(pkg));
        return errorResult(`Query failed: ${lastError}`);
      }

      if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

      const result = output.trim();
      return textResult(
        truncateOutput(result || "(empty result set)", { maxChars: 20000, maxLines: 500 }),
      );
    },
  }),

  // -------------------------------------------------------------------------
  // sandbox_file_list
  // -------------------------------------------------------------------------
  defineTool({
    name: "sandbox_file_list",
    description:
      "List files inside an app's private sandbox directory via adb run-as. " +
      "Equivalent to `ls -la` inside /data/data/<package>/. " +
      "Only works on debuggable apps or userdebug/eng device builds.",
    schema: z.object({
      package: z.string().describe("App package name, e.g. com.example.app"),
      path: z
        .string()
        .optional()
        .describe(
          'Relative path inside the sandbox to list (default: "."). ' +
            'Examples: "databases", "shared_prefs", "files/cache".',
        ),
      platform: androidPlatformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return errorResult("sandbox_file_list is only available on Android.");
      }

      const pkg = args.package;
      validatePackageName(pkg);

      const rawPath = args.path ?? ".";
      validatePath(rawPath, "path");
      const safePath = sanitizeForShell(rawPath) || ".";

      let output: string;
      try {
        output = ctx.deviceManager.shell(`run-as ${pkg} ls -la ${safePath}`, "android", deviceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
        return errorResult(`Failed to list directory: ${msg}`);
      }

      if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

      return textResult(
        truncateOutput(
          `Sandbox listing for "${pkg}" / "${safePath}":\n\n${output || "(empty directory)"}`,
          { maxChars: 15000, maxLines: 300 },
        ),
      );
    },
  }),

  // -------------------------------------------------------------------------
  // sandbox_file_read
  // -------------------------------------------------------------------------
  defineTool({
    name: "sandbox_file_read",
    description:
      "Read the contents of a file from an app's private sandbox via adb run-as. " +
      "Binary files are detected automatically and reported as such. " +
      "Only works on debuggable apps or userdebug/eng device builds.",
    schema: z.object({
      package: z.string().describe("App package name, e.g. com.example.app"),
      path: z
        .string()
        .describe(
          'Relative path to the file inside the sandbox, e.g. "files/config.json" or "databases/app.db".',
        ),
      maxBytes: z
        .number()
        .optional()
        .describe("Maximum characters of file content to return (default: 10000, max: 50000)."),
      platform: androidPlatformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return errorResult("sandbox_file_read is only available on Android.");
      }

      const pkg = args.package;
      validatePackageName(pkg);

      const rawPath = args.path;
      validatePath(rawPath, "path");
      const safePath = sanitizeForShell(rawPath);
      if (safePath.length === 0) {
        return errorResult("Invalid path after sanitization.");
      }

      const maxBytes = Math.min(Math.max(1, args.maxBytes ?? 10_000), 50_000);

      let content: string;
      try {
        content = ctx.deviceManager.shell(`run-as ${pkg} cat ${safePath}`, "android", deviceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
        if (msg.toLowerCase().includes("no such file")) {
          return errorResult(`File not found: "${safePath}" in sandbox of "${pkg}".`);
        }
        return errorResult(`Failed to read file: ${msg}`);
      }

      if (isRunAsFailure(content)) return errorResult(runAsUnavailableHint(pkg));

      if (looksLikeBinary(content)) {
        return textResult(
          `File "${safePath}" in "${pkg}" appears to be a binary file and cannot be displayed as text.\n\n` +
            "If this is a SQLite database, use sandbox(action:'sqlite_query') instead.",
        );
      }

      return textResult(truncateOutput(content, { maxChars: maxBytes, maxLines: 1000 }));
    },
  }),
];
