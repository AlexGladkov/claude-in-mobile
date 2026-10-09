import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { AuroraClient, AudbCommandError } from "./client.js";
import { AuroraAdapter } from "./aurora-adapter.js";

const fixture = readFileSync(new URL("../../../cli/tests/fixtures/audb.py", import.meta.url));
describe.skipIf(process.platform === "win32")("audb 0.3 contract", () => {
  let root: string;
  let client: AuroraClient;
  const calls = () => existsSync(join(root, "calls.jsonl"))
    ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s)) : [];
  const mode = (value: string) => writeFileSync(join(root, "mode"), value);
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "audb-contract-"));
    writeFileSync(join(root, "audb"), fixture); chmodSync(join(root, "audb"), 0o755);
    await sharp({ create: { width: 360, height: 800, channels: 4, background: "white" } }).png().toFile(join(root, "screen.png"));
    client = new AuroraClient({ binaryPath: join(root, "audb"), deviceId: "phone" });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("prefers PATH; rejects its old version instead of using AUDB_PATH", () => {
    const oldPath = process.env.PATH, oldAudb = process.env.AUDB_PATH;
    try {
      process.env.PATH = root; process.env.AUDB_PATH = "/missing/fallback";
      expect(new AuroraClient({ deviceId: "phone" }).shell("true")).toBe("exact output\n\n");
      mode("old");
      expect(() => new AuroraClient().listDevices()).toThrow(/AUDB|0.3.0/);
      expect(calls()).toHaveLength(1);
      process.env.PATH = "/nonexistent"; process.env.AUDB_PATH = join(root, "audb"); mode("");
      expect(new AuroraClient().listDevices()).toHaveLength(2);
      delete process.env.AUDB_PATH;
      expect(() => new AuroraClient().listDevices()).toThrow(/not found/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldAudb === undefined) delete process.env.AUDB_PATH; else process.env.AUDB_PATH = oldAudb;
    }
  });
  it.each([
    ["audb 0.3.0", true], ["audb 0.3.1", true], ["audb 0.2.1", false],
    ["audb 0.4.0", false], ["audb 1.0.0", false], ["audb 0.3.0-rc.1", false],
    ["audb 00.3.0", false], ["unknown 0.3.0", false],
  ])("enforces the declared stable API range for %s", (version, accepted) => {
    writeFileSync(join(root, "version"), String(version));
    if (accepted) { client.tap(1, 2); expect(calls()).toHaveLength(1); }
    else { expect(() => client.tap(1, 2)).toThrow(/\^0\.3\.0/); expect(calls()).toHaveLength(0); }
  });
  it("forwards root only when explicitly requested", () => {
    expect(client.shell("id", true)).toBe("exact output\n\n");
    client.shell("id");
    expect(calls()[0].args.slice(-3)).toEqual(["shell", "--root", "id"]);
    expect(calls()[1].args.slice(-2)).toEqual(["shell", "id"]);
  });
  it("preserves inventory state, pins overrides and never changes audb's default", async () => {
    const adapter = new AuroraAdapter(client);
    expect(adapter.listDevices().map(d => [d.id, d.state, d.isSimulator])).toEqual([["phone", "unknown", false], ["emulator", "unknown", true]]);
    await Promise.all([adapter.tap(10, 20, undefined, "phone"), adapter.inputText("Привет\n😀", undefined, "emulator")]);
    const actions = calls().filter(c => c.args.includes("--device"));
    expect(actions.map(c => c.args[c.args.indexOf("--device") + 1])).toEqual(["phone", "emulator"]);
    expect(Buffer.from(actions[1].stdin, "base64").toString()).toBe("Привет\n😀");
    expect(actions[1].args).not.toContain("Привет\n😀");
    expect(calls().some(c => c.args.includes("select"))).toBe(false);
  });
  it("pins both taps while local selection changes", async () => {
    const adapter = new AuroraAdapter(client);
    const pending = adapter.doubleTap(12, 34, 20);
    adapter.selectDevice("emulator"); await pending;
    expect(calls().filter(c => c.args.includes("tap")).map(c => c.args[c.args.indexOf("--device")+1])).toEqual(["phone", "phone"]);
  });
  it("preserves gestures, permission flags, installation metadata and timeout", () => {
    client.longPress(1, 2, 800); client.swipe(1, 2, 3, 4, 700);
    client.grantPermission("ru.example.app", "UserDirs");
    client.grantAllPermissions("ru.example.app", true);
    client.permissionPrompt("ru.example.app", false);
    expect(JSON.parse(client.installApp("/tmp/app.rpm")).changed).toBe(false);
    const args = calls().map(c => c.args);
    expect(args[0].slice(-5)).toEqual(["tap", "1", "2", "--duration", "800"]);
    expect(args[1].slice(-7)).toEqual(["swipe", "1", "2", "3", "4", "--duration", "700"]);
    expect(args[2]).not.toContain("--disable-prompt");
    expect(args[3].slice(-2)).toEqual(["--all-requested", "--disable-prompt"]);
    expect(args[4].slice(-1)).toEqual(["--disable"]);
    expect(args[5].slice(0, 3)).toEqual(["--json", "--command-timeout", "300"]);
  });
  it("uses real PNG dimensions and cleans temporary screenshot output", async () => {
    const adapter = new AuroraAdapter(client);
    const buffer = await adapter.getScreenshotBufferAsync("emulator");
    expect((await sharp(buffer).metadata()).width).toBe(360);
    const compressed = await adapter.screenshotAsync(true, { maxWidth: 180 }, "phone");
    expect((await sharp(Buffer.from(compressed.data, "base64")).metadata()).width).toBe(180);
    for (const call of calls()) expect(existsSync(call.args[call.args.indexOf("--output") + 1])).toBe(false);
    expect(() => client.getUiHierarchy()).toThrow(/not supported/);
  });
  it("retains nonzero error data and never repeats a failed action", async () => {
    mode("error");
    try { client.tap(1, 2); throw new Error("expected failure"); } catch (e) {
      expect(e).toBeInstanceOf(AudbCommandError);
      expect(e).toMatchObject({ code: "AGENT_UNAVAILABLE", deviceId: "phone", exitStatus: 2, data: { changed: false, partial: true } });
      expect((e as Error).message).toContain('"partial":true');
    }
    expect(calls()).toHaveLength(1);
    await expect(new AuroraAdapter(client).doubleTap(1, 2, 1)).rejects.toThrow(/unavailable/);
    expect(calls()).toHaveLength(2);
  });
  it.each(["lost", "schema", "success-nonzero"])("rejects %s responses without retry", value => {
    mode(value); expect(() => client.swipe(1, 2, 3, 4)).toThrow(); expect(calls()).toHaveLength(1);
  });
});
