import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HdcClient } from "./client.js";
import type { HdcExecutor, HdcFetch } from "./client.js";

interface RecordedCall {
  binary: string;
  args: string[];
}

function decodeDeviceShellCommand(command: string): string[] {
  const protectedQuotes = command.replaceAll(`'"'"'`, "\0");
  return [...protectedQuotes.matchAll(/'([^']*)'/g)]
    .map((match) => match[1]!.replaceAll("\0", "'"));
}

function semanticHdcArgs(args: readonly string[]): string[] {
  const shellIndex = args.indexOf("shell");
  const command = args.at(-1);
  if (shellIndex === -1 || typeof command !== "string" || !command.startsWith("'")) {
    return [...args];
  }
  return [
    ...args.slice(0, -1),
    ...decodeDeviceShellCommand(command),
  ];
}

function fakeHdc(
  calls: RecordedCall[],
  response: (args: readonly string[]) => string = () => "",
): HdcExecutor {
  return (binary, args) => {
    const semanticArgs = semanticHdcArgs(args);
    calls.push({ binary, args: semanticArgs });
    const recvIndex = semanticArgs.findIndex(
      (arg, index) => arg === "recv" && semanticArgs[index - 1] === "file",
    );
    if (recvIndex !== -1) {
      const localPath = semanticArgs[recvIndex + 2];
      const remotePath = semanticArgs[recvIndex + 1];
      if (localPath && remotePath) {
        const content = remotePath.endsWith(".json")
          ? JSON.stringify({ attributes: { type: "Button", text: "Continue", bounds: "[0,0][100,40]" } })
          : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        writeFileSync(localPath, content);
      }
    }
    return response(semanticArgs);
  };
}

describe("HdcClient", () => {
  it("parses verbose HDC targets", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({
      hdcPath: "/sdk/hdc",
      executor: fakeHdc(calls, () => [
        "ABC123 USB Connected Mate60 hdc",
        "127.0.0.1:5555 TCP Offline localhost hdc",
      ].join("\n")),
    });

    expect(client.listDevices()).toEqual([
      {
        id: "ABC123",
        name: "Mate60",
        platform: "harmony",
        state: "connected",
        isSimulator: false,
        connection: "USB",
      },
      {
        id: "127.0.0.1:5555",
        name: "127.0.0.1:5555",
        platform: "harmony",
        state: "offline",
        isSimulator: false,
        connection: "TCP",
      },
    ]);
    expect(calls[0]).toEqual({
      binary: "/sdk/hdc",
      args: ["list", "targets", "-v"],
    });
  });

  it("routes an explicit device without mutating the selected target", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls), deviceId: "selected" });

    client.tap(12, 34, "explicit");

    expect(client.getDeviceId()).toBe("selected");
    expect(calls[0]?.args).toEqual([
      "-t", "explicit", "shell", "uitest", "uiInput", "click", "12", "34",
    ]);
  });

  it("translates gesture durations and common key names to ArkXTest arguments", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls), deviceId: "phone" });

    client.swipe(0, 0, 600, 0, 300);
    client.longPress(10, 20, 1_500);
    client.pressKey("ENTER");
    client.pressKey("back");

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "phone", "shell", "uitest", "uiInput", "swipe", "0", "0", "600", "0", "2000"],
      ["-t", "phone", "shell", "uitest", "uiInput", "longClick", "10", "20", "1500"],
      ["-t", "phone", "shell", "uitest", "uiInput", "keyEvent", "2054"],
      ["-t", "phone", "shell", "uitest", "uiInput", "keyEvent", "Back"],
    ]);
    expect(() => client.pressKey("not-a-key")).toThrow("Unknown HarmonyOS key");
  });

  it("captures PNG and layout through device temp files", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls), deviceId: "phone" });

    expect(client.screenshotRaw()).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(JSON.parse(client.getUiHierarchy())).toMatchObject({
      attributes: { type: "Button", text: "Continue" },
    });
    expect(calls.some((call) => call.args.includes("screenCap"))).toBe(true);
    expect(calls.some((call) => call.args.includes("dumpLayout"))).toBe(true);
    expect(calls.filter((call) => call.args.includes("recv"))).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes("rm"))).toHaveLength(2);
  });

  it("launches default, explicit, and module-qualified abilities", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls) });

    client.launchApp("com.example.demo", "phone");
    client.launchApp("com.example.demo/SettingsAbility", "phone");
    client.launchAbility("com.example.demo", "MainAbility", "entry", "phone");

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "phone", "shell", "aa", "start", "-b", "com.example.demo", "-a", "EntryAbility"],
      ["-t", "phone", "shell", "aa", "start", "-b", "com.example.demo", "-a", "SettingsAbility"],
      ["-t", "phone", "shell", "aa", "start", "-b", "com.example.demo", "-a", "MainAbility", "-m", "entry"],
    ]);
  });

  it("opens URLs through AA without device-shell interpolation", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls) });

    client.openUrl("https://example.com/path?a=1&b=2", "phone");

    expect(calls[0]?.args).toEqual([
      "-t", "phone", "shell", "aa", "start",
      "-A", "ohos.want.action.viewData",
      "-U", "https://example.com/path?a=1&b=2",
    ]);
  });

  it("returns a bounded filtered HiLog snapshot", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({
      executor: fakeHdc(calls, () => [
        "I Demo first",
        "E Other failure",
        "E Demo second",
      ].join("\n")),
    });

    expect(client.getLogs({ level: "E", tag: "Demo", lines: 1 })).toBe("E Demo second");
    expect(calls[0]?.args).toEqual(["hilog", "-x"]);
  });

  it("grants, revokes, and resets only currently granted permissions", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({
      executor: fakeHdc(calls, (args) => {
        if (args.includes("-b")) return JSON.stringify({ tokenId: 42 });
        if (args.includes("-i")) {
          return JSON.stringify({
            tokenId: 42,
            permStateList: [
              { permissionName: "ohos.permission.CAMERA", grantStatus: 0 },
              { permissionName: "ohos.permission.MICROPHONE", grantStatus: 1 },
            ],
          });
        }
        return "";
      }),
    });

    client.grantPermission("com.example.demo", "ohos.permission.CAMERA", "phone");
    client.revokePermission("com.example.demo", "ohos.permission.CAMERA", "phone");
    expect(client.resetPermissions("com.example.demo", "phone")).toBe(
      "Reset 1 granted permissions for com.example.demo",
    );

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "phone", "shell", "atm", "dump", "-t", "-b", "com.example.demo"],
      ["-t", "phone", "shell", "atm", "perm", "-g", "-i", "42", "-p", "ohos.permission.CAMERA"],
      ["-t", "phone", "shell", "atm", "dump", "-t", "-b", "com.example.demo"],
      ["-t", "phone", "shell", "atm", "perm", "-c", "-i", "42", "-p", "ohos.permission.CAMERA"],
      ["-t", "phone", "shell", "atm", "dump", "-t", "-b", "com.example.demo"],
      ["-t", "phone", "shell", "atm", "dump", "-t", "-i", "42"],
      ["-t", "phone", "shell", "atm", "perm", "-c", "-i", "42", "-p", "ohos.permission.CAMERA"],
    ]);
  });

  it("discovers, forwards, inspects, and disposes ArkWeb targets", async () => {
    const calls: RecordedCall[] = [];
    const fetcher: HdcFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "page-1", title: "Demo" }],
    });
    const client = new HdcClient({
      executor: fakeHdc(calls, (args) =>
        args.includes("/proc/net/unix")
          ? "00000000: 00000002 00000000 00010000 0001 01 1 @webview_devtools_remote_123"
          : ""
      ),
      fetcher,
    });

    await expect(client.inspectArkWeb(undefined, 9_333, "phone")).resolves.toEqual({
      socket: "webview_devtools_remote_123",
      forwardedPort: 9_333,
      targets: [{ id: "page-1", title: "Demo" }],
    });
    client.dispose();

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "phone", "shell", "cat", "/proc/net/unix"],
      ["-t", "phone", "fport", "tcp:9333", "localabstract:webview_devtools_remote_123"],
      ["-t", "phone", "fport", "rm", "tcp:9333", "localabstract:webview_devtools_remote_123"],
    ]);
  });

  it("uses bundle-scoped HDC file commands and ArkXTest filters", () => {
    const calls: RecordedCall[] = [];
    const client = new HdcClient({ executor: fakeHdc(calls) });

    client.sandboxList("com.example.demo", "files", "phone");
    client.sandboxRead("com.example.demo", "files/state.json", 3, "phone");
    client.sandboxPush("com.example.demo", "/tmp/input", "files/input", "phone");
    client.sandboxPull("com.example.demo", "files/output", "/tmp/output", "phone");
    client.runTests(
      "com.example.demo",
      "entry_test",
      "OpenHarmonyTestRunner",
      {
        class: "LoginSuite#opens",
        notClass: "LoginSuite#flaky",
        timeoutMs: 30_000,
        dryRun: true,
      },
      "phone",
    );

    expect(calls.map((call) => call.args)).toEqual([
      ["-t", "phone", "shell", "-b", "com.example.demo", "ls", "-la", "files"],
      ["-t", "phone", "shell", "-b", "com.example.demo", "cat", "files/state.json"],
      ["-t", "phone", "file", "send", "-b", "com.example.demo", "/tmp/input", "files/input"],
      ["-t", "phone", "file", "recv", "-b", "com.example.demo", "files/output", "/tmp/output"],
      [
        "-t", "phone", "shell", "aa", "test", "-b", "com.example.demo",
        "-m", "entry_test", "-s", "unittest", "OpenHarmonyTestRunner",
        "-s", "class", "LoginSuite#opens",
        "-s", "notClass", "LoginSuite#flaky",
        "-s", "timeout", "30000",
        "-s", "dryRun", "true",
      ],
    ]);
  });

  it("reports a missing HDC binary with an actionable error", () => {
    const missing: HdcExecutor = () => {
      const error = new Error("spawn ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    };
    const client = new HdcClient({ hdcPath: "/missing/hdc", executor: missing });

    expect(() => client.listDevices()).toThrow("set HDC_PATH");
  });
});
