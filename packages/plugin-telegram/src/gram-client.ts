/**
 * gram-client -- a thin, testable wrapper over GramJS (`telegram`).
 *
 * Design choices that satisfy the security gate:
 *
 *   - The real GramJS module is imported LAZILY (`await import("telegram")`)
 *     inside the default driver factory only. Unit tests inject a fake driver
 *     and never load GramJS, so there is no live network and no native module
 *     load in CI. (This is a deliberate, stronger alternative to
 *     `vi.mock("telegram")`: the heavy module is never even resolved in tests.)
 *
 *   - GramJS logging is forced to `LogLevel.NONE` via `baseLogger`, and the
 *     Session object is never logged.
 *
 *   - FLOOD_WAIT is honoured with a hard cap (`FLOOD_CAP_SECONDS`); waits
 *     beyond the cap fail fast instead of sleeping for a long time.
 *
 *   - Every error surfaced to the caller is run through `sanitizeErrorMessage`
 *     so a StringSession / bot-token echoed into an error never escapes.
 *
 *   - The phone-number / auto-register path is reachable ONLY on the test DC
 *     (guarded by `assertTestDcOnly`). Prod re-uses a pre-supplied session.
 */

import type { Api } from "telegram";

import { sanitizeErrorMessage } from "mcp-devices/utils/sanitize";

import {
  assertTestDcOnly,
  buildTestDcIdentity,
  type TelegramCredentials,
} from "./identity.js";
import type { RawButton, RawMessage } from "./conversation-tree.js";

/** Hard cap: a FLOOD_WAIT longer than this fails instead of sleeping. */
export const FLOOD_CAP_SECONDS = 300;
/** How many times to retry an action after a (sub-cap) FLOOD_WAIT. */
export const MAX_FLOOD_RETRIES = 2;

// ── Minimal GramJS surface we depend on (kept tiny for test injection) ──

export interface TgLowLevelClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(entity: string, params: { message: string }): Promise<Api.Message>;
  getMessages(
    entity: string,
    params: { limit: number },
  ): Promise<Api.Message[]>;
  invoke(request: unknown): Promise<unknown>;
  /** test-DC auto-register only -- absent on prod-built drivers. */
  start?(params: unknown): Promise<void>;
}

export interface GramDriver {
  readonly client: TgLowLevelClient;
  /** Construct a `messages.GetBotCallbackAnswer` request for `client.invoke`. */
  buildCallbackRequest(peer: string, msgId: number, data: Buffer): unknown;
  /** FLOOD_WAIT seconds if `err` is a flood-wait error, else null. */
  floodWaitSeconds(err: unknown): number | null;
}

export type GramDriverFactory = (
  creds: TelegramCredentials,
) => Promise<GramDriver>;

export interface GramClientOptions {
  /** Override the GramJS driver (tests inject a fake; prod uses the default). */
  factory?: GramDriverFactory;
  /** Override the sleep used for FLOOD_WAIT backoff (tests pass a no-op). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Allow disposable test-DC auto-registration when no session is supplied. */
  allowAutoRegister?: boolean;
}

export class GramClient {
  private readonly factory: GramDriverFactory;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly allowAutoRegister: boolean;

  private driver: GramDriver | null = null;
  private connected = false;
  private peer = "";
  private mode: TelegramCredentials["mode"] = "test";

  constructor(opts: GramClientOptions = {}) {
    this.factory = opts.factory ?? defaultGramDriverFactory;
    this.sleepFn =
      opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.allowAutoRegister = opts.allowAutoRegister ?? false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPeer(): string {
    return this.peer;
  }

  getMode(): TelegramCredentials["mode"] {
    return this.mode;
  }

  /**
   * Establish the session and bind it to a bot peer. `creds` MUST come from
   * `loadCredentials` (env-only). DC-sanity is asserted before any action: a
   * prod connection without a pre-supplied session is rejected upstream by
   * `loadCredentials`; the disposable-identity path here is test-DC-only.
   */
  async connect(creds: TelegramCredentials, peer: string): Promise<void> {
    if (!peer || !peer.startsWith("@")) {
      throw new Error(
        `Invalid bot peer: "${peer}". Expected a public @username.`,
      );
    }
    this.mode = creds.mode;
    this.peer = peer;
    this.driver = await this.factory(creds);

    await this.withFlood(() => this.driver!.client.connect());

    if (!creds.stringSession) {
      if (!this.allowAutoRegister) {
        throw new Error(
          "No StringSession supplied and auto-register is disabled " +
            "(state: needs_login). Provide TELEGRAM_STRING_SESSION or enable " +
            "disposable test-DC provisioning.",
        );
      }
      // The ONLY phone-login path. Structurally test-DC-only.
      assertTestDcOnly(creds.mode, "auto-register a disposable identity");
      const identity = buildTestDcIdentity();
      const start = this.driver.client.start;
      if (!start) {
        throw new Error(
          "Driver does not support auto-registration (no start()).",
        );
      }
      await this.withFlood(() =>
        start.call(this.driver!.client, {
          phoneNumber: async () => identity.phoneNumber,
          phoneCode: async () => identity.phoneCode,
          onError: (err: unknown) => {
            throw new Error(
              sanitizeErrorMessage(
                err instanceof Error ? err.message : String(err),
              ),
            );
          },
        }),
      );
    }

    this.connected = true;
  }

  /** Send a text message / command to the bot under test. */
  async sendMessage(text: string): Promise<void> {
    this.assertReady();
    await this.withFlood(() =>
      this.driver!.client.sendMessage(this.peer, { message: text }),
    );
  }

  /**
   * Press an inline callback button. Returns the bot's alert/toast text, if
   * any (sanitised), so callers can assert on it.
   */
  async pressCallback(msgId: number, data: Buffer): Promise<string | undefined> {
    this.assertReady();
    const request = this.driver!.buildCallbackRequest(this.peer, msgId, data);
    const answer = (await this.withFlood(() =>
      this.driver!.client.invoke(request),
    )) as { message?: string } | undefined;
    const message = answer?.message;
    return message ? sanitizeErrorMessage(message) : undefined;
  }

  /** Fetch the last `limit` messages, newest-first from GramJS, normalised. */
  async getHistory(limit = 20): Promise<RawMessage[]> {
    this.assertReady();
    const messages = await this.withFlood(() =>
      this.driver!.client.getMessages(this.peer, { limit }),
    );
    // GramJS returns newest-first; the snapshot wants oldest-first.
    return [...messages].reverse().map(normaliseMessage);
  }

  async disconnect(): Promise<void> {
    if (this.driver && this.connected) {
      try {
        await this.driver.client.disconnect();
      } catch {
        // best-effort
      }
    }
    this.connected = false;
  }

  private assertReady(): void {
    if (!this.driver || !this.connected) {
      throw new Error("Telegram client is not connected. Call connect() first.");
    }
  }

  /**
   * Run `fn`, honouring FLOOD_WAIT with a hard cap. Any non-flood error (or a
   * cap breach) is rethrown with a sanitised message.
   */
  private async withFlood<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const seconds = this.driver?.floodWaitSeconds(err) ?? null;
        if (seconds !== null && attempt < MAX_FLOOD_RETRIES) {
          if (seconds > FLOOD_CAP_SECONDS) {
            throw new Error(
              `FLOOD_WAIT of ${seconds}s exceeds cap ${FLOOD_CAP_SECONDS}s -- ` +
                "aborting instead of sleeping.",
            );
          }
          await this.sleepFn(seconds * 1000);
          continue;
        }
        throw new Error(
          sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}

// ── GramJS Api.Message -> RawMessage normalisation ──

/** Extract one keyboard button into our platform-neutral RawButton. */
function normaliseButton(raw: unknown): RawButton {
  const b = raw as {
    text?: string;
    data?: Buffer;
    url?: string;
    className?: string;
  };
  const text = b.text ?? "";
  if (b.data) {
    return { text, kind: "callback", data: Buffer.from(b.data) };
  }
  if (b.url) {
    return { text, kind: "url", url: b.url };
  }
  return { text, kind: "reply" };
}

function normaliseMessage(raw: Api.Message): RawMessage {
  const m = raw as unknown as {
    id: number;
    out?: boolean;
    message?: string;
    replyMarkup?: { rows?: Array<{ buttons?: unknown[] }> };
  };
  const buttonRows: RawButton[][] = [];
  const rows = m.replyMarkup?.rows ?? [];
  for (const row of rows) {
    const buttons = (row.buttons ?? []).map(normaliseButton);
    if (buttons.length > 0) buttonRows.push(buttons);
  }
  return {
    id: m.id,
    fromBot: !m.out,
    text: m.message ?? "",
    buttonRows,
  };
}

// ── Default (production) GramJS driver ──

/**
 * Build a real GramJS driver. Lazily imports `telegram` so unit tests that
 * inject their own factory never pull GramJS in.
 */
export const defaultGramDriverFactory: GramDriverFactory = async (creds) => {
  const tg = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const { FloodWaitError } = await import("telegram/errors/index.js");
  const { Logger } = await import("telegram/extensions/index.js");
  const { LogLevel } = await import("telegram/extensions/Logger.js");

  const session = new StringSession(creds.stringSession ?? "");
  const client = new tg.TelegramClient(session, creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    // Force silence: never log the session or MTProto traffic.
    baseLogger: new Logger(LogLevel.NONE),
  });

  return {
    client: client as unknown as TgLowLevelClient,
    buildCallbackRequest(peer, msgId, data) {
      return new tg.Api.messages.GetBotCallbackAnswer({
        peer,
        msgId,
        data,
      });
    },
    floodWaitSeconds(err) {
      if (err instanceof FloodWaitError) return err.seconds;
      // Duck-type fallback for wrapped/mismatched class identities.
      const e = err as { seconds?: number; className?: string } | undefined;
      if (
        e &&
        typeof e.seconds === "number" &&
        typeof e.className === "string" &&
        /flood/i.test(e.className)
      ) {
        return e.seconds;
      }
      return null;
    },
  };
};
