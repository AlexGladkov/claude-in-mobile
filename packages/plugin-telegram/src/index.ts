/**
 * Telegram bot-testing plugin.
 *
 * Exposes a Telegram-bot conversation as a `telegram` platform target so the
 * existing ui_tree / input_tap / input_text / ui_wait verbs can drive a black
 * box e2e against a bot over MTProto (GramJS userbot), with no core edits.
 *
 * The kernel bridge (`adaptersFromKernel`,
 * src/device/kernel-device-locator.ts) picks up `plugin.adapter` keyed by
 * `manifest.id = "telegram"`. The open `Platform` type already admits the new
 * id; no entry is added to `BUILTIN_PLATFORMS`.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import { TelegramAdapter, type TelegramAdapterOptions } from "./telegram-adapter.js";

export const TELEGRAM_PLUGIN_MANIFEST: PluginManifest = {
  id: "telegram",
  name: "Telegram",
  version: "4.0.0-dev",
  apiVersion: "1",
  // Conversation == UI tree; messages/buttons == input; synthetic device.
  // No screen (v1), shell, app lifecycle, permissions, logs, or file transfer.
  capabilities: ["ui", "input", "deviceMgmt"],
  description:
    "Telegram bot automation via MTProto userbot (GramJS): the dialog is " +
    "modelled as a UI tree so ui/input verbs test bots black-box.",
  homepage: "https://github.com/AlexGladkov/claude-in-mobile",
};

export class TelegramPlugin implements SourcePlugin {
  readonly manifest = TELEGRAM_PLUGIN_MANIFEST;
  readonly adapter: TelegramAdapter;

  constructor(adapter: TelegramAdapter = new TelegramAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {}
}

export function createTelegramPlugin(opts?: TelegramAdapterOptions): SourcePlugin {
  return new TelegramPlugin(opts ? new TelegramAdapter(opts) : undefined);
}

export { TelegramAdapter } from "./telegram-adapter.js";
export { GramClient } from "./gram-client.js";
export { SessionStore } from "./session-store.js";
export {
  loadCredentials,
  resolveDcMode,
  buildTestDcIdentity,
} from "./identity.js";
export {
  buildSnapshot,
  serializeSnapshotToXml,
  decodeTap,
  encodeButtonBounds,
} from "./conversation-tree.js";

export const createPlugin = createTelegramPlugin;
export default createTelegramPlugin;
