import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserAdapter } from "./browser-adapter.js";
import type { BrowserClient } from "./browser/client.js";
import { SessionManager } from "./browser/session-manager.js";
import type { BrowserSession } from "./browser/types.js";
import { WebPlugin } from "./index.js";

const roots: string[] = [];

function sessionManager(): SessionManager {
  const root = mkdtempSync(join(tmpdir(), "mcp-browser-adapter-"));
  roots.push(root);
  return new SessionManager(root);
}

function fakeSession(id: string, lockToken = "token"): BrowserSession {
  return { id, lockToken } as unknown as BrowserSession;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BrowserAdapter lifecycle", () => {
  it("closes a launched session when initial snapshot fails", async () => {
    const manager = sessionManager();
    const session = fakeSession("default");
    const close = vi.fn(async () => {});
    const client = {
      launch: vi.fn(async () => session),
      getSnapshot: vi.fn(async () => { throw new Error("snapshot failed"); }),
      close,
    } as unknown as BrowserClient;
    const adapter = new BrowserAdapter(manager, client);

    await expect(adapter.open({ url: "https://example.com" })).rejects.toThrow("snapshot failed");

    expect(close).toHaveBeenCalledWith(session);
  });

  it("redacts query secrets from the public open result", async () => {
    const manager = sessionManager();
    const session = fakeSession("default");
    const client = {
      launch: vi.fn(async () => session),
      getSnapshot: vi.fn(async () => "snapshot"),
      close: vi.fn(async () => {}),
    } as unknown as BrowserClient;
    const adapter = new BrowserAdapter(manager, client);

    const result = await adapter.open({
      url: "https://user:pass@example.com/login?code=oauth-secret#access_token=fragment",
    });

    expect(result).toContain("https://example.com/login?[REDACTED]#[REDACTED]");
    expect(result).not.toContain("user:pass");
    expect(result).not.toContain("oauth-secret");
    expect(result).not.toContain("access_token=fragment");
  });

  it("disposes every active session through the client", async () => {
    const manager = sessionManager();
    const token = manager.acquireLock("owned");
    const session = fakeSession("owned", token);
    manager.setSession("owned", session, token);
    const close = vi.fn(async () => {
      manager.removeSession("owned");
      manager.releaseLock("owned", token);
    });
    const client = { close } as unknown as BrowserClient;
    const adapter = new BrowserAdapter(manager, client);

    await adapter.dispose();

    expect(close).toHaveBeenCalledWith(session);
  });

  it("waits for an in-flight open before disposing its session", async () => {
    const manager = sessionManager();
    let releaseLaunch: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let session: BrowserSession | undefined;
    const close = vi.fn(async (active: BrowserSession) => {
      manager.removeSession(active.id);
      manager.releaseLock(active.id, active.lockToken);
    });
    const client = {
      launch: vi.fn(async () => {
        const token = manager.acquireLock("default");
        session = fakeSession("default", token);
        manager.setSession("default", session, token);
        markStarted?.();
        await launchGate;
        return session;
      }),
      getSnapshot: vi.fn(async () => "snapshot"),
      close,
    } as unknown as BrowserClient;
    const adapter = new BrowserAdapter(manager, client);

    const opening = adapter.open({ url: "https://example.com" });
    await started;
    const disposing = adapter.dispose();
    releaseLaunch?.();
    await opening;
    await disposing;

    expect(close).toHaveBeenCalledWith(session);
    expect(manager.listSessions()).toEqual([]);
  });

  it("does not clear a profile held by another manager", async () => {
    const owner = sessionManager();
    const token = owner.acquireLock("shared");
    const contender = new SessionManager(owner.profileBaseDir);
    const adapter = new BrowserAdapter(contender, {} as unknown as BrowserClient);

    await expect(adapter.clearSessionData("shared")).rejects.toThrow(`live PID ${process.pid}`);

    owner.releaseLock("shared", token);
  });

  it("delegates plugin disposal", async () => {
    const adapter = { dispose: vi.fn(async () => {}) } as unknown as BrowserAdapter;

    await new WebPlugin(adapter).dispose();

    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
});
