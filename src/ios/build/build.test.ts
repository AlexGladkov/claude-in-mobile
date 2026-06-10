import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";

// child_process is mocked for the WHOLE file — no real xcodebuild/altool ever runs.
// exec.ts does promisify(execFile) at module load; the mock (a plain vi.fn) takes
// the generic promisify path: (file, args, opts, cb) -> cb(err, {stdout, stderr}).
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));

import { detectIosProject, listSchemes, pickReleaseScheme } from "./project-detector.js";
import { writeExportOptionsPlist, renderExportOptionsPlist } from "./export-options.js";
import { classifyXcodeError, redactSigningInfo } from "./classify-build-error.js";
import { uploadIpa } from "./upload.js";
import { MobileError } from "../../errors.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type ExecCb = (
  err: (Error & { stderr?: string; killed?: boolean }) | null,
  result?: { stdout: string; stderr: string },
) => void;

function execOk(stdout = "", stderr = ""): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    (args[args.length - 1] as ExecCb)(null, { stdout, stderr });
  });
}

function execFail(stderr: string): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    (args[args.length - 1] as ExecCb)(Object.assign(new Error("command failed"), { stderr }));
  });
}

/** argv of the n-th execFile call: [file, args]. */
function callArgs(n: number): { file: string; args: string[] } {
  const call = execFileMock.mock.calls[n] as unknown[];
  return { file: call[0] as string, args: call[1] as string[] };
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ios-build-test-"));
}

const tmpDirs: string[] = [];

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixtureDir(): Promise<string> {
  const dir = await makeTmpDir();
  tmpDirs.push(dir);
  return dir;
}

// ── project detection ────────────────────────────────────────────────────────

describe("detectIosProject", () => {
  it("detects flutter (pubspec.yaml + ios/)", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "pubspec.yaml"), "name: app\n");
    await mkdir(join(dir, "ios", "Runner.xcworkspace"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("flutter");
    expect(info.buildDir).toBe(dir);
    expect(info.workspacePath).toBe(join(dir, "ios", "Runner.xcworkspace"));
  });

  it("detects react-native (package.json dep + ios/*.xcworkspace)", async () => {
    const dir = await fixtureDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "react-native": "0.74.0" } }),
    );
    await mkdir(join(dir, "ios", "MyApp.xcworkspace"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("react-native");
    expect(info.workspacePath).toBe(join(dir, "ios", "MyApp.xcworkspace"));
    expect(info.buildDir).toBe(join(dir, "ios"));
  });

  it("does NOT treat a non-RN package.json + ios/ as react-native", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    await mkdir(join(dir, "ios"), { recursive: true });
    await mkdir(join(dir, "App.xcodeproj"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("xcode");
  });

  it("detects kmp (iosApp/*.xcodeproj)", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "iosApp", "iosApp.xcodeproj"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("kmp");
    expect(info.projectPath).toBe(join(dir, "iosApp", "iosApp.xcodeproj"));
    expect(info.buildDir).toBe(join(dir, "iosApp"));
  });

  it("detects plain xcode and prefers workspace over project", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "App.xcworkspace"), { recursive: true });
    await mkdir(join(dir, "App.xcodeproj"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("xcode");
    expect(info.workspacePath).toBe(join(dir, "App.xcworkspace"));
    expect(info.projectPath).toBeUndefined();
  });

  it("falls back to *.xcodeproj when no workspace exists", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "App.xcodeproj"), { recursive: true });

    const info = await detectIosProject(dir);
    expect(info.kind).toBe("xcode");
    expect(info.projectPath).toBe(join(dir, "App.xcodeproj"));
  });

  it("throws IOS_PROJECT_NOT_FOUND on an empty directory", async () => {
    const dir = await fixtureDir();
    await expect(detectIosProject(dir)).rejects.toMatchObject({ code: "IOS_PROJECT_NOT_FOUND" });
  });

  it("blocks path traversal in dir", async () => {
    await expect(detectIosProject("/tmp/../etc")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_BLOCKED",
    });
  });
});

describe("listSchemes", () => {
  it("invokes xcodebuild -list -json with -workspace and parses schemes", async () => {
    execOk(JSON.stringify({ workspace: { name: "App", schemes: ["App", "AppTests"] } }));

    const schemes = await listSchemes({
      kind: "xcode",
      workspacePath: "/proj/App.xcworkspace",
      buildDir: "/proj",
    });
    expect(schemes).toEqual(["App", "AppTests"]);

    const { file, args } = callArgs(0);
    expect(file).toBe("xcodebuild");
    expect(args).toEqual(["-list", "-json", "-workspace", "/proj/App.xcworkspace"]);
  });

  it("uses -project when only projectPath is available", async () => {
    execOk(JSON.stringify({ project: { schemes: ["iosApp"] } }));

    const schemes = await listSchemes({
      kind: "kmp",
      projectPath: "/proj/iosApp/iosApp.xcodeproj",
      buildDir: "/proj/iosApp",
    });
    expect(schemes).toEqual(["iosApp"]);
    expect(callArgs(0).args).toContain("-project");
  });

  it("throws XCODE_LIST_PARSE_ERROR on garbage output", async () => {
    execOk("not json");
    await expect(
      listSchemes({ kind: "xcode", projectPath: "/p/App.xcodeproj", buildDir: "/p" }),
    ).rejects.toMatchObject({ code: "XCODE_LIST_PARSE_ERROR" });
  });
});

describe("pickReleaseScheme", () => {
  it('prefers exact "Release"', () => {
    expect(pickReleaseScheme(["Debug", "Release", "App"])).toBe("Release");
  });
  it('falls back to "-Release" suffix', () => {
    expect(pickReleaseScheme(["App-Debug", "App-Release", "App"])).toBe("App-Release");
  });
  it("then first scheme not matching Tests|Debug", () => {
    expect(pickReleaseScheme(["AppTests", "AppDebug", "App"])).toBe("App");
  });
  it("falls back to the first scheme when all match Tests|Debug", () => {
    expect(pickReleaseScheme(["AppTests", "AppUITests"])).toBe("AppTests");
  });
  it("throws on empty list", () => {
    expect(() => pickReleaseScheme([])).toThrowError(MobileError);
  });
});

// ── ExportOptions.plist ──────────────────────────────────────────────────────

describe("writeExportOptionsPlist", () => {
  it("writes the default app-store-connect upload plist", async () => {
    const dir = await fixtureDir();
    const path = await writeExportOptionsPlist(dir);

    expect(basename(path)).toMatch(/^ExportOptions-[0-9a-f]{8}\.plist$/);
    const content = await readFile(path, "utf-8");
    expect(content).toBe(renderExportOptionsPlist());
    expect(content).toMatchSnapshot();
  });

  it("honours destination=export and manageVersion=false", async () => {
    const dir = await fixtureDir();
    const path = await writeExportOptionsPlist(dir, {
      destination: "export",
      manageVersion: false,
    });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("<string>export</string>");
    expect(content).toContain("<key>manageAppVersionAndBuildNumber</key>\n\t<false/>");
    expect(content).toContain("<key>signingStyle</key>\n\t<string>automatic</string>");
    expect(content).toContain("<key>generateAppStoreInformation</key>\n\t<true/>");
  });

  it("blocks traversal in the target directory", async () => {
    await expect(writeExportOptionsPlist("/tmp/../etc")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_BLOCKED",
    });
  });
});

// ── error classification + redaction ─────────────────────────────────────────

describe("classifyXcodeError", () => {
  it("maps signing failures to TESTFLIGHT_SIGNING_ERROR", () => {
    const err = classifyXcodeError(
      'error: No signing certificate "iOS Distribution" found',
      "xcodebuild archive",
    ) as MobileError;
    expect(err.code).toBe("TESTFLIGHT_SIGNING_ERROR");
  });

  it("maps CODE_SIGN errors to TESTFLIGHT_SIGNING_ERROR", () => {
    const err = classifyXcodeError(
      "CODE_SIGN_IDENTITY is required for product type Application",
      "xcodebuild archive",
    ) as MobileError;
    expect(err.code).toBe("TESTFLIGHT_SIGNING_ERROR");
  });

  it("maps duplicate uploads to TESTFLIGHT_VERSION_COLLISION", () => {
    const err = classifyXcodeError(
      "ERROR: The bundle version 42 has already been uploaded.",
      "altool upload",
    ) as MobileError;
    expect(err.code).toBe("TESTFLIGHT_VERSION_COLLISION");
  });

  it("maps auth failures to ASC_AUTH_ERROR", () => {
    const err = classifyXcodeError(
      "Authentication credentials are missing or invalid. (401)",
      "altool upload",
    ) as MobileError;
    expect(err.code).toBe("ASC_AUTH_ERROR");
  });

  it("maps Missing Compliance to upload error with compliance hint", () => {
    const err = classifyXcodeError(
      'WARNING: Missing Compliance for build 1.2.3',
      "altool upload",
    ) as MobileError;
    expect(err.code).toBe("ASC_UPLOAD_ERROR");
    expect(err.message).toContain("ITSAppUsesNonExemptEncryption");
  });

  it("defaults to ASC_UPLOAD_ERROR with at most a 200-char stderr tail", () => {
    const stderr = "x".repeat(5000) + " final failure marker";
    const err = classifyXcodeError(stderr, "xcodebuild archive") as MobileError;
    expect(err.code).toBe("ASC_UPLOAD_ERROR");
    expect(err.message).toContain("final failure marker");
    expect(err.message.length).toBeLessThan(300);
    expect(err.message).not.toContain("x".repeat(300));
  });

  it("never leaks AuthKey_*.p8 file names into the message", () => {
    const stderr =
      "error: No signing certificate found\n" +
      "Could not read /Users/dev/keys/AuthKey_ABC123.p8\n" +
      "Build failed";
    const err = classifyXcodeError(stderr, "xcodebuild archive") as MobileError;
    expect(err.code).toBe("TESTFLIGHT_SIGNING_ERROR");
    expect(err.message).not.toContain("AuthKey_ABC123");
    expect(err.message).not.toContain(".p8");
  });

  it("strips signing identity lines (Apple Distribution / Developer ID)", () => {
    const stderr =
      "Signing Identity: Apple Distribution: Jane Doe (TEAM123456)\n" +
      "Developer ID Application: Jane Doe\n" +
      "error: something else failed";
    const err = classifyXcodeError(stderr, "xcodebuild archive") as MobileError;
    expect(err.message).not.toContain("Jane Doe");
    expect(err.message).not.toContain("TEAM123456");
    expect(err.message).toContain("something else failed");
  });
});

describe("redactSigningInfo", () => {
  it("drops lines with key material and redacts stray tokens", () => {
    const input = "ok line\nusing AuthKey_ZZZ.p8 here\nanother ok line";
    const out = redactSigningInfo(input);
    expect(out).toContain("ok line");
    expect(out).not.toContain("AuthKey_ZZZ");
    expect(out).not.toContain(".p8");
  });
});

// ── uploadIpa ────────────────────────────────────────────────────────────────

describe("uploadIpa", () => {
  let ipaPath: string;

  beforeEach(async () => {
    const dir = await fixtureDir();
    ipaPath = join(dir, "app.ipa");
    await writeFile(ipaPath, Buffer.alloc(64, 0x42));
  });

  it("builds the modern --upload-package argv", async () => {
    execOk();
    await uploadIpa({ ipaPath, keyId: "AB12CD34EF", issuerId: "11aa22bb-1234-5678-9abc-def012345678" });

    const { file, args } = callArgs(0);
    expect(file).toBe("xcrun");
    expect(args).toEqual([
      "altool", "--upload-package", ipaPath,
      "-t", "ios",
      "--apiKey", "AB12CD34EF",
      "--apiIssuer", "11aa22bb-1234-5678-9abc-def012345678",
    ]);
  });

  it("retries with --upload-app -f when --upload-package is unknown", async () => {
    execFail("Error: unrecognized option '--upload-package'");
    execOk();

    await uploadIpa({ ipaPath, keyId: "KEY1", issuerId: "ISSUER1" });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    const { args } = callArgs(1);
    expect(args.slice(0, 4)).toEqual(["altool", "--upload-app", "-f", ipaPath]);
  });

  it("does NOT retry on genuine upload failures", async () => {
    execFail("ERROR: The bundle has already been uploaded. DUPLICATE.");

    await expect(uploadIpa({ ipaPath, keyId: "KEY1", issuerId: "ISSUER1" })).rejects.toMatchObject({
      code: "TESTFLIGHT_VERSION_COLLISION",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-.ipa paths before any exec", async () => {
    await expect(
      uploadIpa({ ipaPath: "/tmp/app.apk", keyId: "K", issuerId: "I" }),
    ).rejects.toMatchObject({ code: "INVALID_IPA_PATH" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects path traversal in ipaPath", async () => {
    await expect(
      uploadIpa({ ipaPath: "/tmp/../etc/app.ipa", keyId: "K", issuerId: "I" }),
    ).rejects.toMatchObject({ code: "PATH_TRAVERSAL_BLOCKED" });
  });

  it("rejects malformed credentials before any exec", async () => {
    await expect(
      uploadIpa({ ipaPath, keyId: "bad key$", issuerId: "I" }),
    ).rejects.toMatchObject({ code: "INVALID_ASC_CREDENTIALS" });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects missing IPA files", async () => {
    await expect(
      uploadIpa({ ipaPath: join(tmpdir(), "definitely-missing.ipa"), keyId: "K", issuerId: "I" }),
    ).rejects.toMatchObject({ code: "IPA_NOT_FOUND" });
  });
});
