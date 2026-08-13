/**
 * Shared Zod fragments for tool schemas.
 *
 * Many tool files declare identical `platform` / `deviceId` fields. This
 * module centralises them so the field shape cannot drift between files.
 *
 * Behavioural contract:
 *   - `platformEnum` — optional platform string, described as "Target
 *     platform. If not specified, uses the active target.". The value is an
 *     open string: platform validity is resolved at runtime by
 *     `DeviceManager.getAdapter()` against the *installed* platform set
 *     (built-ins + plugins), which throws "Platform '...' is not installed.
 *     Available: ...". A compile-time enum would reject plugin platforms
 *     (e.g. telegram) before that check ever runs.
 *   - `deviceIdField` — optional device id string with the canonical
 *     multi-device description.
 *
 * Files with intentionally narrower platform sets (e.g. autopilot, a11y)
 * keep their own enums and only reuse `deviceIdField`.
 */

import { z } from "./define-tool.js";

export const platformEnum = z
  .string()
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

export const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();
