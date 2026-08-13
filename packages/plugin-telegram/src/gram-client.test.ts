import { describe, expect, it, vi } from "vitest";

import {
  FLOOD_CAP_SECONDS,
  GramClient,
  type GramDriver,
  type GramDriverFactory,
  type TgLowLevelClient,
} from "./gram-client.js";
import type { TelegramCredentials } from "./identity.js";

/**
 * No live network: a fake GramJS driver is injected. The real `telegram`
 * module is never imported (the default factory's dynamic import is bypassed).
 */

class FakeFloodWaitError extends Error {
  readonly className = "FloodWaitError";
  constructor(public readonly seconds: number) {
    super(`A wait of ${seconds} seconds is required (caused by ...)`);
  }
}

interface FakeClientOptions {
  callbackAnswer?: { message?: string };
  history?: unknown[];
  sendImpl?: () => Promise<unknown>;
  hasStart?: boolean;
}

function makeDriver(opts: FakeClientOptions = {}): {
  driver: GramDriver;
  client: TgLowLevelClient & {
    sendMessage: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    getMessages: ReturnType<typeof vi.fn>;
    start?: ReturnType<typeof vi.fn>;
  };
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const client = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(opts.sendImpl ?? (async () => ({ id: 1 }))),
    getMessages: vi.fn(async () => opts.history ?? []),
    invoke: vi.fn(async () => opts.callbackAnswer ?? { message: "ok" }),
    ...(opts.hasStart ? { start: vi.fn(async () => {}) } : {}),
  } as unknown as TgLowLevelClient & Record<string, ReturnType<typeof vi.fn>>;

  const driver: GramDriver = {
    client,
    buildCallbackRequest(peer, msgId, data) {
      const req = { peer, msgId, data };
      requests.push(req);
      return req;
    },
    floodWaitSeconds(err) {
      return err instanceof FakeFloodWaitError ? err.seconds : null;
    },
  };
  return { driver, client: client as never, requests };
}

function testCreds(over: Partial<TelegramCredentials> = {}): TelegramCredentials {
  return {
    apiId: 123,
    apiHash: "hash",
    mode: "test",
    stringSession: "SESSION",
    ...over,
  };
}

function factoryOf(driver: GramDriver): GramDriverFactory {
  return async () => driver;
}

describe("GramClient.connect", () => {
  it("rejects a non-@username peer", async () => {
    const { driver } = makeDriver();
    const c = new GramClient({ factory: factoryOf(driver) });
    await expect(c.connect(testCreds(), "my_bot")).rejects.toThrow(/@username/);
  });

  it("connects with a pre-supplied session and binds the peer", async () => {
    const { driver, client } = makeDriver();
    const c = new GramClient({ factory: factoryOf(driver) });
    await c.connect(testCreds(), "@my_bot");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(c.isConnected()).toBe(true);
    expect(c.getPeer()).toBe("@my_bot");
  });

  it("refuses to login when no session and auto-register is disabled", async () => {
    const { driver } = makeDriver();
    const c = new GramClient({ factory: factoryOf(driver), allowAutoRegister: false });
    await expect(
      c.connect(testCreds({ stringSession: undefined }), "@my_bot"),
    ).rejects.toThrow(/needs_login/);
  });

  it("auto-registers a deterministic disposable identity on the test DC", async () => {
    const { driver, client } = makeDriver({ hasStart: true });
    const c = new GramClient({ factory: factoryOf(driver), allowAutoRegister: true });
    await c.connect(testCreds({ stringSession: undefined }), "@my_bot");
    expect(client.start).toHaveBeenCalledOnce();
    const startArgs = client.start!.mock.calls[0][0] as {
      phoneNumber: () => Promise<string>;
      phoneCode: () => Promise<string>;
    };
    await expect(startArgs.phoneNumber()).resolves.toMatch(/^99966\d/);
    await expect(startArgs.phoneCode()).resolves.toMatch(/^\d{5}$/);
  });

  it("never takes the phone path on prod (auto-register guarded to test DC)", async () => {
    const { driver, client } = makeDriver({ hasStart: true });
    const c = new GramClient({ factory: factoryOf(driver), allowAutoRegister: true });
    await expect(
      c.connect(testCreds({ mode: "prod", stringSession: undefined }), "@my_bot"),
    ).rejects.toThrow(/test-DC-only/);
    expect(client.start).not.toHaveBeenCalled();
  });
});

describe("GramClient actions", () => {
  it("sendMessage forwards text to the bound peer", async () => {
    const { driver, client } = makeDriver();
    const c = new GramClient({ factory: factoryOf(driver) });
    await c.connect(testCreds(), "@my_bot");
    await c.sendMessage("/start");
    expect(client.sendMessage).toHaveBeenCalledWith("@my_bot", { message: "/start" });
  });

  it("pressCallback builds a callback request, invokes it, returns alert text", async () => {
    const { driver, client, requests } = makeDriver({
      callbackAnswer: { message: "Saved!" },
    });
    const c = new GramClient({ factory: factoryOf(driver) });
    await c.connect(testCreds(), "@my_bot");
    const alert = await c.pressCallback(42, Buffer.from("yes"));
    expect(alert).toBe("Saved!");
    expect(client.invoke).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({ peer: "@my_bot", msgId: 42 });
  });

  it("getHistory normalises Api.Message rows oldest-first", async () => {
    const history = [
      // newest-first as GramJS returns
      {
        id: 2,
        out: true,
        message: "Yes",
        replyMarkup: undefined,
      },
      {
        id: 1,
        out: false,
        message: "Choose:",
        replyMarkup: {
          rows: [
            {
              buttons: [
                { text: "Yes", data: Buffer.from("y") },
                { text: "Site", url: "https://x.com" },
              ],
            },
          ],
        },
      },
    ];
    const { driver } = makeDriver({ history });
    const c = new GramClient({ factory: factoryOf(driver) });
    await c.connect(testCreds(), "@my_bot");
    const msgs = await c.getHistory();
    expect(msgs.map((m) => m.id)).toEqual([1, 2]); // reversed to chronological
    expect(msgs[0].fromBot).toBe(true);
    expect(msgs[1].fromBot).toBe(false);
    expect(msgs[0].buttonRows[0][0]).toMatchObject({ text: "Yes", kind: "callback" });
    expect(msgs[0].buttonRows[0][1]).toMatchObject({ text: "Site", kind: "url" });
  });
});

describe("GramClient FLOOD_WAIT handling", () => {
  it("sleeps and retries on a sub-cap flood-wait, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const { driver } = makeDriver({
      sendImpl: async () => {
        calls += 1;
        if (calls === 1) throw new FakeFloodWaitError(5);
        return { id: 1 };
      },
    });
    const c = new GramClient({
      factory: factoryOf(driver),
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await c.connect(testCreds(), "@my_bot");
    await c.sendMessage("hi");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5000]);
  });

  it("fails fast when the flood-wait exceeds the cap", async () => {
    const { driver } = makeDriver({
      sendImpl: async () => {
        throw new FakeFloodWaitError(FLOOD_CAP_SECONDS + 1);
      },
    });
    const c = new GramClient({ factory: factoryOf(driver), sleepFn: async () => {} });
    await c.connect(testCreds(), "@my_bot");
    await expect(c.sendMessage("hi")).rejects.toThrow(/exceeds cap/);
  });

  it("routes surfaced errors through sanitizeErrorMessage (redacts secrets)", async () => {
    // Asserts the integration point this module OWNS: every error GramClient
    // surfaces passes through core's sanitizeErrorMessage. We assert against a
    // redaction rule (`token=...`) that is stable across core builds, so the
    // test does not couple to whichever rule set the core dist currently ships
    // (the bot-token/StringSession rules are core's responsibility and have
    // their own tests in src/utils/sanitize.ts).
    const secret = "AAH1234567890abcdefghijklmnopqrstuvwx";
    const { driver } = makeDriver({
      sendImpl: async () => {
        throw new Error(`upstream failed: token=${secret}`);
      },
    });
    const c = new GramClient({ factory: factoryOf(driver), sleepFn: async () => {} });
    await c.connect(testCreds(), "@my_bot");
    await expect(c.sendMessage("hi")).rejects.toThrow(/\[REDACTED\]/);
    await expect(c.sendMessage("hi")).rejects.not.toThrow(new RegExp(secret));
  });
});
