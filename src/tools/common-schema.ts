/**
 * Shared Zod fragments for tool schemas.
 *
 * Many tool files declare identical `platform` / `deviceId` fields. This
 * module centralises them so the platform list (sourced from
 * `BUILTIN_PLATFORMS` in `device-manager.ts`) cannot drift between files.
 *
 * Behavioural contract:
 *   - `platformEnum` — optional platform string, described as "Target
 *     platform. If not specified, uses the active target.". Enum values
 *     come from `BUILTIN_PLATFORMS`.
 *   - `deviceIdField` — optional device id string with the canonical
 *     multi-device description.
 *
 * Files with intentionally narrower platform sets (e.g. autopilot, a11y)
 * keep their own enums and only reuse `deviceIdField`.
 */

import { z } from "./define-tool.js";
import { BUILTIN_PLATFORMS } from "../device-manager.js";

// `z.enum` requires a non-empty tuple type. `BUILTIN_PLATFORMS` is a
// readonly array of literal platform ids; cast it to the tuple shape Zod
// expects without copying the values.
const PLATFORM_TUPLE = BUILTIN_PLATFORMS as readonly [string, ...string[]];

export const platformEnum = z
  .enum(PLATFORM_TUPLE)
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

export const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();
