import { validatePackageName } from "../../utils/sanitize.js";
import { buildDeviceShellCommand } from "../../utils/device-shell.js";
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


    const dbRelPath = `databases/${rawDb}`;
    const dbAbsPath = `/data/data/${pkg}/databases/${rawDb}`;

    // Try relative path via run-as first; fall back to absolute path.
    let output: string | undefined;
    let unavailable = false;

    for (const dbPath of [dbRelPath, dbAbsPath]) {
      try {
        output = ctx.deviceManager.shell(
          buildDeviceShellCommand([
            "run-as",
            pkg,
            "sqlite3",
            "-readonly",
            dbPath,
            query,
          ]),
          "android",
          deviceId,
        );
        if (!isRunAsFailure(output)) break;
        return errorResult(runAsUnavailableHint(pkg));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(message)) {
          return errorResult(runAsUnavailableHint(pkg));
        }
        unavailable = message.toLowerCase().includes("not found") ||
          message.toLowerCase().includes("no such file");
      }
    }

    if (output === undefined) {
      if (unavailable) {
        return errorResult(
          "sqlite3 is unavailable or the sandbox database was not found.",
        );
      }
      return errorResult("Sandbox query failed.");
    }

    if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

    const result = output.trim();
    return textResult(
      truncateOutput(result || "(empty result set)", { maxChars: 20000, maxLines: 500 }),
    );
  },
});
