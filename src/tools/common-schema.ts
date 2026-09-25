/**
 * Shared Zod fragments for tool schemas.
 *
 * Many tool files declare identical `platform` / `deviceId` fields. This
 * module centralises them so every generic tool accepts a bounded platform
 * identifier without letting arbitrary strings reach the device manager.
 *
 * Behavioural contract:
 *   - `platformEnum` — optional platform string, described as "Target
 *     platform. If not specified, uses the active target.". Built-in values
 *     remain an enum branch for client autocomplete; external platform IDs
 *     use the bounded identifier branch.
 *   - `deviceIdField` — optional device id string with the canonical
 *     multi-device description.
 *
 * Files with intentionally narrower platform sets (e.g. autopilot, a11y)
 * keep their own enums and only reuse `deviceIdField`.
 */

import { z } from "./define-tool.js";
import { BUILTIN_PLATFORMS } from "../device-manager.js";

const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// `z.enum` requires a non-empty tuple type. `BUILTIN_PLATFORMS` is a
// readonly array of literal platform ids; cast it to the tuple shape Zod
// expects without copying the values.
const PLATFORM_TUPLE = BUILTIN_PLATFORMS as readonly [string, ...string[]];

const externalPlatformId = z
  .string()
  .min(1)
  .max(128)
  .regex(PLATFORM_ID_RE, "platform must match /^[a-z0-9][a-z0-9._-]*$/");

export const platformIdSchema = z
  .union([z.enum(PLATFORM_TUPLE), externalPlatformId])
  .describe("Target platform. If not specified, uses the active target.");

export const platformEnum = platformIdSchema.optional();

export const deviceIdField = z

  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

/** JSON Schema counterpart used by meta-tools that do not use Zod directly. */
export const PLATFORM_JSON_SCHEMA = {
  anyOf: [
    { type: "string", enum: [...BUILTIN_PLATFORMS] },
    {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
    },
  ],
} as const;
