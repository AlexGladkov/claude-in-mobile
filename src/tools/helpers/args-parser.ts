/**
 * Type-safe argument parsers for tool handlers.
 *
 * Replaces raw `args.x as number` casts with runtime-validated accessors.
 * Each function checks the actual runtime type before returning, eliminating
 * the risk of silent type mismatches propagated by `as` casts.
 */

import { ValidationError } from "../../errors.js";

export function getString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  return typeof val === "string" ? val : undefined;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = getString(args, key);
  if (val === undefined) throw new ValidationError(`Missing required parameter: ${key}`);
  return val;
}

export function getNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  return typeof val === "number" ? val : undefined;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = getNumber(args, key);
  if (val === undefined) throw new ValidationError(`Missing required parameter: ${key}`);
  return val;
}

export function getBoolean(args: Record<string, unknown>, key: string, defaultVal = false): boolean {
  const val = args[key];
  return typeof val === "boolean" ? val : defaultVal;
}

export function getStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const val = args[key];
  return Array.isArray(val) ? val.map(String) : undefined;
}
