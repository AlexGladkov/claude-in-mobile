import { execFile } from "child_process";
import { promisify } from "util";

import type { PerformanceTraceSummary } from "../adapters/platform-adapter.js";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const QUERY = (packageName?: string) => {
  const processFilter = packageName
    ? `WHERE p.name = '${packageName.replaceAll("'", "''")}' OR p.cmdline LIKE '${packageName.replaceAll("'", "''")}%'`
    : "";
  return `
SELECT
  (SELECT COUNT(*) FROM slice) AS slice_count,
  (SELECT COUNT(*) FROM sched) AS sched_slice_count,
  (SELECT ROUND(COALESCE(SUM(s.dur), 0) / 1000000.0, 1)
     FROM sched s
     JOIN thread t USING (utid)
     LEFT JOIN process p USING (upid)
     ${processFilter}) AS cpu_time_ms,
  (SELECT COUNT(*) FROM slice
     WHERE dur > 16666666
       AND (name LIKE '%Choreographer#doFrame%'
         OR name LIKE '%DrawFrame%'
         OR name LIKE '%deliverInputEvent%')) AS jank_slice_count;
`.trim();
};

export async function analyzePerfettoTrace(
  tracePath: string,
  packageName?: string,
): Promise<Partial<PerformanceTraceSummary>> {
  const binary = process.env.PERFETTO_TRACE_PROCESSOR_PATH ?? "trace_processor";
  try {
    const { stdout } = await execFileAsync(binary, ["query", tracePath, QUERY(packageName)], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: minimalEnvironment(),
    });
    const row = parseSingleRowCsv(stdout);
    return {
      sliceCount: numeric(row.slice_count),
      schedSliceCount: numeric(row.sched_slice_count),
      cpuTimeMs: numeric(row.cpu_time_ms),
      jankSliceCount: numeric(row.jank_slice_count),
      analysisTool: "Perfetto Trace Processor",
    };
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (details.code === "ENOENT") {
      return {
        analysisTool: "unavailable",
        warnings: [
          "Perfetto Trace Processor is not installed. Set PERFETTO_TRACE_PROCESSOR_PATH to the official trace_processor executable for SQL analysis.",
        ],
      };
    }
    return {
      analysisTool: "failed",
      warnings: ["Perfetto Trace Processor analysis failed."],
    };
  }
}

function parseSingleRowCsv(output: string): Record<string, string> {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("Trace Processor returned no query row.");
  const headers = parseCsvLine(lines[lines.length - 2]);
  const values = parseCsvLine(lines[lines.length - 1]);
  if (headers.length !== values.length) throw new Error("Trace Processor returned malformed CSV.");
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value.toLowerCase() === "null") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
