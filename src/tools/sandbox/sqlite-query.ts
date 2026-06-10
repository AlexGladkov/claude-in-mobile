import { validatePackageName } from "../../utils/sanitize.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import {
  androidPlatformEnum,
  isRunAsFailure,
  runAsUnavailableHint,
  validateDatabaseName,
  validateSqlQuery,
} from "./helpers.js";

export const sandboxSqliteQueryTool = defineTool({
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
});
