/**
 * TelegramAdapter -- presents a Telegram-bot conversation as a
 * `CorePlatformAdapter` so the existing ui/input verbs drive it unchanged.
 *
 * Capability mapping (and the deliberate "not supported" surface):
 *
 *   getUiHierarchy()  -> serialise the current dialog to uiautomator-XML.
 *                        Refreshes the cached snapshot every call, which is
 *                        what makes the tap-decode below well-defined.
 *   tap(x, y)         -> decode `y` back to a button (HOLE #1) and either
 *                        answer a callback or send a reply-keyboard text.
 *   inputText(text)   -> send a message / command to the bot.
 *
 *   doubleTap / longPress / swipe / swipeDirection -> THROW. A linear chat
 *     transcript has no spatial gestures; pretending otherwise (e.g. tapping
 *     twice) would fire duplicate callbacks. Failing loudly is correct.
 *   pressKey          -> Enter/Send/Done are no-ops (inputText already sends);
 *                        any other key THROWS.
 *   screenshotAsync / getScreenshotBufferAsync -> THROW (v1). The dialog is
 *     text; `ui_tree` is the cheap, lossless render. Media rendering is future
 *     work, per the design.
 *
 * The adapter does NOT implement AppManagement / Permissions / Shell -- a bot
 * conversation has no apps, permissions, or shell.
 */

import type { CorePlatformAdapter } from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import type { CompressOptions } from "mcp-devices/utils/image";

import { GramClient } from "./gram-client.js";
import { SessionStore } from "./session-store.js";
import { loadCredentials } from "./identity.js";
import {
  buildSnapshot,
  decodeTap,
  serializeSnapshotToXml,
  type ConversationSnapshot,
} from "./conversation-tree.js";

const ENTER_KEYS = new Set(["enter", "return", "send", "done", "go"]);

export interface TelegramAdapterConfig {
  /** Synthetic device / session id (carries the DC mode marker). */
  readonly sessionId?: string;
  /** Bot under test, e.g. "@my_bot". */
  readonly botUsername?: string;
  /** How many trailing messages to include in a snapshot. */
  readonly historyLimit?: number;
  /** Allow disposable test-DC auto-registration when no session is supplied. */
  readonly allowAutoRegister?: boolean;
}

export interface TelegramAdapterOptions {
  client?: GramClient;
  store?: SessionStore;
  config?: TelegramAdapterConfig;
}

export class TelegramAdapter implements CorePlatformAdapter {
  readonly platform = "telegram" as const;

  private readonly client: GramClient;
  private readonly store: SessionStore;
  private readonly config: TelegramAdapterConfig;
  private snapshot: ConversationSnapshot | null = null;
  private connecting: Promise<void> | null = null;

  constructor(opts: TelegramAdapterOptions = {}) {
    this.config = opts.config ?? {};
    this.client =
      opts.client ??
      new GramClient({ allowAutoRegister: this.config.allowAutoRegister });
    this.store = opts.store ?? new SessionStore();
  }

  /** Raw client access -- parallels AuroraAdapter.getClient(). */
  getClient(): GramClient {
    return this.client;
  }

  // ============ Device management ============

  listDevices(): Device[] {
    const peer = this.client.getPeer() || this.config.botUsername;
    if (!peer) return [];
    return [this.syntheticDevice(peer)];
  }

  selectDevice(_deviceId: string): void {
    // Single session per adapter instance; selection is implicit.
  }

  getSelectedDeviceId(): string | undefined {
    return this.config.sessionId;
  }

  autoDetectDevice(): Device | undefined {
    return this.listDevices()[0];
  }

  private syntheticDevice(peer: string): Device {
    return {
      id: this.config.sessionId ?? `telegram-${this.client.getMode()}`,
      name: peer,
      platform: "telegram",
      state: this.client.isConnected() ? "connected" : "disconnected",
      isSimulator: true,
    };
  }

  // ============ Core interaction ============

  async tap(x: number, y: number): Promise<void> {
    await this.ensureSnapshot();
    const button = decodeTap(this.snapshot!, y);
    if (button.kind === "callback") {
      if (!button.data) {
        throw new Error(
          `Callback button "${button.text}" (${button.ref}) has no payload; ` +
            "cannot answer it.",
        );
      }
      await this.client.pressCallback(button.msgId, button.data);
    } else {
      // reply-keyboard button -> sending its label is the press.
      await this.client.sendMessage(button.text);
    }
    await this.refreshSnapshot();
  }

  async doubleTap(): Promise<void> {
    throw new Error(
      "doubleTap is not supported on telegram: a chat transcript has no " +
        "spatial gestures, and a double press would fire a duplicate callback.",
    );
  }

  async longPress(): Promise<void> {
    throw new Error("longPress is not supported on telegram.");
  }

  async swipe(): Promise<void> {
    throw new Error(
      "swipe is not supported on telegram: the conversation has no scrollable " +
        "spatial surface. Use ui_tree to read more history.",
    );
  }

  async swipeDirection(): Promise<void> {
    throw new Error("swipeDirection is not supported on telegram.");
  }

  async inputText(text: string): Promise<void> {
    await this.ensureConnected();
    await this.client.sendMessage(text);
    await this.refreshSnapshot();
  }

  async pressKey(key: string): Promise<void> {
    if (ENTER_KEYS.has(key.toLowerCase())) {
      // inputText already sends the message; Enter is a no-op here.
      return;
    }
    throw new Error(
      `Key "${key}" is not supported on telegram. Only Enter/Send/Done are ` +
        "accepted (and are no-ops, since inputText sends immediately).",
    );
  }

  // ============ Screenshot (v1: unsupported) ============

  async screenshotAsync(
    _compress: boolean,
    _options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    throw new Error(
      "screen capture is not supported on telegram in v1. The dialog is text " +
        "-- use ui_tree (cheaper and lossless).",
    );
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    throw new Error("screen capture is not supported on telegram in v1.");
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    await this.refreshSnapshot();
    return serializeSnapshotToXml(this.snapshot!);
  }

  // ============ System info ============

  async getSystemInfo(): Promise<string> {
    const peer = this.client.getPeer() || this.config.botUsername || "(none)";
    // No secrets: session id, bot username, DC mode, connection state only.
    return [
      `platform: telegram`,
      `dc: ${this.client.getMode()}`,
      `bot: ${peer}`,
      `session: ${this.config.sessionId ?? "(ephemeral)"}`,
      `connected: ${this.client.isConnected()}`,
    ].join("\n");
  }

  // ============ Internal ============

  private async ensureConnected(): Promise<void> {
    if (this.client.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const peer = this.config.botUsername;
    if (!peer) {
      throw new Error(
        "No bot under test configured (botUsername). Cannot connect.",
      );
    }
    const creds = loadCredentials();
    // Prefer a persisted session if env did not provide one.
    let stringSession = creds.stringSession;
    if (!stringSession && this.config.sessionId) {
      stringSession = (await this.store.load(this.config.sessionId)) ?? undefined;
    }
    await this.client.connect({ ...creds, stringSession }, peer);
  }

  private async ensureSnapshot(): Promise<void> {
    if (!this.snapshot) {
      await this.refreshSnapshot();
    }
  }

  private async refreshSnapshot(): Promise<void> {
    await this.ensureConnected();
    const peer = this.client.getPeer() || this.config.botUsername || "@unknown";
    const history = await this.client.getHistory(this.config.historyLimit ?? 20);
    this.snapshot = buildSnapshot(peer, history);
  }
}
