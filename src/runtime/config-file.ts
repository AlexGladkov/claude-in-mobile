import {
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ensurePrivateDirectorySync,
  readPrivateFileSync,
} from "../utils/private-storage.js";

export interface RuntimeConfigFile {
  platforms?: unknown;
  tool_plugins?: unknown;
  external_plugins?: unknown;
  [key: string]: unknown;
}
const runtimeConfigKeySchema = z.string().min(1).max(128).refine(
  (key) => !/[\u0000-\u001f\u007f]/.test(key)
    && key !== "__proto__"
    && key !== "constructor"
    && key !== "prototype",
  "Runtime config contains an invalid key",
);
const MAX_RUNTIME_CONFIG_BYTES = 1024 * 1024;
const runtimeConfigSchema = z
  .record(runtimeConfigKeySchema, z.unknown())
  .superRefine((config, ctx) => {
    if (Object.keys(config).length > 256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Runtime config exceeds the 256-key limit",
      });
    }
  });

export function runtimeConfigPath(): string {
  return join(homedir(), ".mcp-devices", "config.json");
}

export function readRuntimeConfig(path = runtimeConfigPath()): RuntimeConfigFile {
  try {
    const data = readPrivateFileSync(path, MAX_RUNTIME_CONFIG_BYTES, "runtime config");
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    return runtimeConfigSchema.parse(parsed);
  } catch {
    // Missing, malformed, oversized, or symlinked config starts from an empty object.
    return {};
  }
}

export function updateRuntimeConfig(
  patch: Partial<RuntimeConfigFile>,
  path = runtimeConfigPath(),
): void {
  const config = runtimeConfigSchema.parse({ ...readRuntimeConfig(path), ...patch });
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RUNTIME_CONFIG_BYTES) {
    throw new Error(`Runtime config exceeds ${MAX_RUNTIME_CONFIG_BYTES} bytes`);
  }

  const directory = dirname(path);
  ensurePrivateDirectorySync(directory);

  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
