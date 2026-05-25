import type { ToolDefinition } from "./registry.js";
import { validatePackageName, validatePath, sanitizeForShell } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";

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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const sandboxTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // sandbox_prefs_read
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sandbox_prefs_read",
      description:
        "Read SharedPreferences XML from an app's private sandbox via adb run-as. " +
        "Parses the XML and returns a formatted key-value list. " +
        "If no file is specified, lists all available preference files first. " +
        "Only works on debuggable apps or userdebug/eng device builds.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "App package name, e.g. com.example.app",
          },
          file: {
            type: "string",
            description:
              "SharedPreferences file name without .xml extension, e.g. \"preferences\" or \"user_settings\". " +
              "If omitted, lists available files.",
          },
          platform: {
            type: "string",
            enum: ["android"],
            description: "Target platform. Sandbox access is Android-only.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as string | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: "sandbox_prefs_read is only available on Android.", isError: true };
      }

      const pkg = args.package as string;
      validatePackageName(pkg);

      const adb = ctx.deviceManager.getAndroidClient();

      // No file specified — list available preference files first.
      if (!args.file) {
        let listOutput: string;
        try {
          listOutput = adb.shell(`run-as ${pkg} ls shared_prefs/`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isRunAsFailure(msg)) return { text: runAsUnavailableHint(pkg), isError: true };
          return { text: `Failed to list shared_prefs: ${msg}`, isError: true };
        }

        if (isRunAsFailure(listOutput)) return { text: runAsUnavailableHint(pkg), isError: true };

        const files = listOutput
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.endsWith(".xml"));

        if (files.length === 0) {
          return { text: `No SharedPreferences files found for "${pkg}".` };
        }

        return {
          text:
            `Available SharedPreferences files for "${pkg}":\n` +
            files.map(f => `  - ${f.replace(/\.xml$/, "")}`).join("\n") +
            "\n\nRe-run with file:<name> to read a specific file.",
        };
      }

      // Validate and sanitize the file name.
      const rawFile = args.file as string;
      validatePath(rawFile, "file");
      const safeFile = sanitizeForShell(rawFile);
      if (safeFile.length === 0) {
        return { text: "Invalid file name after sanitization.", isError: true };
      }

      let xmlContent: string;
      try {
        xmlContent = adb.shell(`run-as ${pkg} cat shared_prefs/${safeFile}.xml`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return { text: runAsUnavailableHint(pkg), isError: true };
        return { text: `Failed to read preferences: ${msg}`, isError: true };
      }

      if (isRunAsFailure(xmlContent)) return { text: runAsUnavailableHint(pkg), isError: true };
      if (!xmlContent || xmlContent.trim().length === 0) {
        return { text: `File "shared_prefs/${safeFile}.xml" is empty or does not exist.` };
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
        return {
          text: `No parseable entries found in "${safeFile}.xml". Raw content:\n\n${truncateOutput(xmlContent, { maxChars: 5000 })}`,
        };
      }

      return {
        text:
          `SharedPreferences: "${pkg}" / "${safeFile}.xml"\n` +
          `${entries.length} entries:\n\n` +
          entries.join("\n"),
      };
    },
  },

  // -------------------------------------------------------------------------
  // sandbox_prefs_write
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sandbox_prefs_write",
      description:
        "Write or update a single value in an app's SharedPreferences XML via adb run-as. " +
        "Uses sed to replace the target key in-place inside the XML file. " +
        "The app must be restarted after writing for changes to take effect. " +
        "Only works on debuggable apps or userdebug/eng device builds.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "App package name, e.g. com.example.app",
          },
          file: {
            type: "string",
            description: "SharedPreferences file name without .xml extension, e.g. \"preferences\"",
          },
          key: {
            type: "string",
            description: "Preference key to write",
          },
          value: {
            type: "string",
            description: "New value to set",
          },
          type: {
            type: "string",
            enum: ["string", "int", "bool", "float", "long"],
            description: "Value type (default: string). Determines the XML element tag used.",
          },
          platform: {
            type: "string",
            enum: ["android"],
            description: "Target platform. Sandbox access is Android-only.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package", "file", "key", "value"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as string | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: "sandbox_prefs_write is only available on Android.", isError: true };
      }

      const pkg = args.package as string;
      validatePackageName(pkg);

      const rawFile = args.file as string;
      validatePath(rawFile, "file");
      const safeFile = sanitizeForShell(rawFile);
      if (safeFile.length === 0) {
        return { text: "Invalid file name after sanitization.", isError: true };
      }

      const rawKey = args.key as string;
      const safeKey = sanitizeForShell(rawKey);
      if (safeKey.length === 0) {
        return { text: "Invalid key after sanitization.", isError: true };
      }

      const rawValue = args.value as string;
      const safeValue = sanitizeForShell(rawValue);

      const type = (args.type as string | undefined) ?? "string";

      const adb = ctx.deviceManager.getAndroidClient();
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
        output = adb.shell(sedCmd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return { text: runAsUnavailableHint(pkg), isError: true };
        return { text: `Failed to write preference: ${msg}`, isError: true };
      }

      if (isRunAsFailure(output)) return { text: runAsUnavailableHint(pkg), isError: true };

      return {
        text:
          `Preference updated in "${pkg}" / "${safeFile}.xml":\n` +
          `  key   = ${safeKey}\n` +
          `  value = ${safeValue}\n` +
          `  type  = ${type}\n\n` +
          "NOTE: The app must be restarted for the change to take effect. " +
          "Use app(action:'restart', package:'<pkg>') or force-stop and relaunch.",
      };
    },
  },

  // -------------------------------------------------------------------------
  // sandbox_sqlite_query
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sandbox_sqlite_query",
      description:
        "Run a read-only SQL query against an app's SQLite database via adb run-as + sqlite3. " +
        "Supports SELECT and PRAGMA queries. Write operations are blocked. " +
        "Only works on debuggable apps or userdebug/eng device builds.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "App package name, e.g. com.example.app",
          },
          database: {
            type: "string",
            description: "Database filename, e.g. \"app.db\" or \"mydata.sqlite\"",
          },
          query: {
            type: "string",
            description: "SQL query to execute. Only SELECT and PRAGMA are allowed.",
          },
          platform: {
            type: "string",
            enum: ["android"],
            description: "Target platform. Sandbox access is Android-only.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package", "database", "query"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as string | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: "sandbox_sqlite_query is only available on Android.", isError: true };
      }

      const pkg = args.package as string;
      validatePackageName(pkg);

      const rawDb = args.database as string;
      validateDatabaseName(rawDb);

      const query = args.query as string;
      validateSqlQuery(query);

      // Sanitize the query for safe shell quoting (single-quote based).
      // Escape single quotes inside the query by ending the string, adding \',
      // then starting a new string: ' -> '\''
      const shellSafeQuery = query.replace(/'/g, "'\\''");

      const adb = ctx.deviceManager.getAndroidClient();
      const dbRelPath = `databases/${rawDb}`;
      const dbAbsPath = `/data/data/${pkg}/databases/${rawDb}`;

      // Try relative path via run-as first; fall back to absolute path.
      let output: string | undefined;
      let lastError = "";

      for (const dbPath of [dbRelPath, dbAbsPath]) {
        try {
          output = adb.shell(`run-as ${pkg} sqlite3 ${dbPath} '${shellSafeQuery}'`);
          if (!isRunAsFailure(output)) break;
          // Treat run-as failure from the relative path attempt and try absolute.
          lastError = output;
          output = undefined;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (isRunAsFailure(lastError)) {
            return { text: runAsUnavailableHint(pkg), isError: true };
          }
          // sqlite3 might not be found on the device — provide helpful message.
          if (lastError.toLowerCase().includes("not found") || lastError.toLowerCase().includes("no such file")) {
            return {
              text:
                `sqlite3 is not available on this device or the database file was not found.\n\n` +
                `Tried paths:\n  ${dbRelPath}\n  ${dbAbsPath}\n\n` +
                "sqlite3 is pre-installed on most Android emulators but may be absent on physical devices.\n" +
                `Error: ${lastError}`,
              isError: true,
            };
          }
          // Continue to try the next path.
        }
      }

      if (!output) {
        if (isRunAsFailure(lastError)) return { text: runAsUnavailableHint(pkg), isError: true };
        return { text: `Query failed: ${lastError}`, isError: true };
      }

      if (isRunAsFailure(output)) return { text: runAsUnavailableHint(pkg), isError: true };

      const result = output.trim();
      return {
        text: truncateOutput(result || "(empty result set)", { maxChars: 20000, maxLines: 500 }),
      };
    },
  },

  // -------------------------------------------------------------------------
  // sandbox_file_list
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sandbox_file_list",
      description:
        "List files inside an app's private sandbox directory via adb run-as. " +
        "Equivalent to `ls -la` inside /data/data/<package>/. " +
        "Only works on debuggable apps or userdebug/eng device builds.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "App package name, e.g. com.example.app",
          },
          path: {
            type: "string",
            description:
              "Relative path inside the sandbox to list (default: \".\"). " +
              "Examples: \"databases\", \"shared_prefs\", \"files/cache\".",
          },
          platform: {
            type: "string",
            enum: ["android"],
            description: "Target platform. Sandbox access is Android-only.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as string | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: "sandbox_file_list is only available on Android.", isError: true };
      }

      const pkg = args.package as string;
      validatePackageName(pkg);

      const rawPath = (args.path as string | undefined) ?? ".";
      validatePath(rawPath, "path");
      const safePath = sanitizeForShell(rawPath) || ".";

      const adb = ctx.deviceManager.getAndroidClient();

      let output: string;
      try {
        output = adb.shell(`run-as ${pkg} ls -la ${safePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return { text: runAsUnavailableHint(pkg), isError: true };
        return { text: `Failed to list directory: ${msg}`, isError: true };
      }

      if (isRunAsFailure(output)) return { text: runAsUnavailableHint(pkg), isError: true };

      return {
        text: truncateOutput(
          `Sandbox listing for "${pkg}" / "${safePath}":\n\n${output || "(empty directory)"}`,
          { maxChars: 15000, maxLines: 300 },
        ),
      };
    },
  },

  // -------------------------------------------------------------------------
  // sandbox_file_read
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sandbox_file_read",
      description:
        "Read the contents of a file from an app's private sandbox via adb run-as. " +
        "Binary files are detected automatically and reported as such. " +
        "Only works on debuggable apps or userdebug/eng device builds.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "App package name, e.g. com.example.app",
          },
          path: {
            type: "string",
            description:
              "Relative path to the file inside the sandbox, e.g. \"files/config.json\" or \"databases/app.db\".",
          },
          maxBytes: {
            type: "number",
            description:
              "Maximum characters of file content to return (default: 10000, max: 50000).",
          },
          platform: {
            type: "string",
            enum: ["android"],
            description: "Target platform. Sandbox access is Android-only.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package", "path"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as string | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: "sandbox_file_read is only available on Android.", isError: true };
      }

      const pkg = args.package as string;
      validatePackageName(pkg);

      const rawPath = args.path as string;
      validatePath(rawPath, "path");
      const safePath = sanitizeForShell(rawPath);
      if (safePath.length === 0) {
        return { text: "Invalid path after sanitization.", isError: true };
      }

      const maxBytes = Math.min(
        Math.max(1, (args.maxBytes as number | undefined) ?? 10_000),
        50_000,
      );

      const adb = ctx.deviceManager.getAndroidClient();

      let content: string;
      try {
        content = adb.shell(`run-as ${pkg} cat ${safePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return { text: runAsUnavailableHint(pkg), isError: true };
        if (msg.toLowerCase().includes("no such file")) {
          return { text: `File not found: "${safePath}" in sandbox of "${pkg}".`, isError: true };
        }
        return { text: `Failed to read file: ${msg}`, isError: true };
      }

      if (isRunAsFailure(content)) return { text: runAsUnavailableHint(pkg), isError: true };

      if (looksLikeBinary(content)) {
        return {
          text:
            `File "${safePath}" in "${pkg}" appears to be a binary file and cannot be displayed as text.\n\n` +
            "If this is a SQLite database, use sandbox(action:'sqlite_query') instead.",
        };
      }

      return {
        text: truncateOutput(content, { maxChars: maxBytes, maxLines: 1000 }),
      };
    },
  },
];
