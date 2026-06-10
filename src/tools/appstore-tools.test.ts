import { describe, it, expect, vi, beforeEach } from "vitest";
import { MobileError, ValidationError } from "../errors.js";

// ──────────────────────────────────────────────
// Mocks — ASC client + iOS build pipeline. No network, no xcodebuild.
// ──────────────────────────────────────────────

const ascMocks = vi.hoisted(() => ({
  findApp: vi.fn(),
  getBuilds: vi.fn(),
  setWhatToTest: vi.fn(),
  getBetaGroups: vi.fn(),
  addBuildToGroup: vi.fn(),
  submitForBetaReview: vi.fn(),
  setEncryptionExempt: vi.fn(),
  getAscAuthFromEnv: vi.fn(),
}));

vi.mock("../store/app-store-connect.js", () => ({
  AppStoreConnectClient: class {
    findApp = ascMocks.findApp;
    getBuilds = ascMocks.getBuilds;
    setWhatToTest = ascMocks.setWhatToTest;
    getBetaGroups = ascMocks.getBetaGroups;
    addBuildToGroup = ascMocks.addBuildToGroup;
    submitForBetaReview = ascMocks.submitForBetaReview;
    setEncryptionExempt = ascMocks.setEncryptionExempt;
  },
  getAscAuthFromEnv: ascMocks.getAscAuthFromEnv,
}));

const buildMocks = vi.hoisted(() => ({
  detectIosProject: vi.fn(),
  listSchemes: vi.fn(),
  pickReleaseScheme: vi.fn(),
  writeExportOptionsPlist: vi.fn(),
  archiveApp: vi.fn(),
  exportArchive: vi.fn(),
  buildFlutterIpa: vi.fn(),
  uploadIpa: vi.fn(),
}));

vi.mock("../ios/build/index.js", () => buildMocks);

import { appStoreTools } from "./appstore-tools.js";
import { storeMeta, storeAliases } from "./meta/store-meta.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = appStoreTools.find((t) => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in appStoreTools`);
  return def.handler;
}

// Handlers don't use ctx (module-level lazy ASC client); pass a minimal mock.
const dummyCtx = {} as never;

const ENV_AUTH = {
  keyId: "AB12CD34EF",
  issuerId: "11aa22bb-1234-5678-9abc-def012345678",
  keyPath: "/Users/dev/keys/AuthKey_AB12CD34EF.p8",
};

const APP = { id: "app-1", name: "My App" };

function build(id: string, version: string, processingState: string): {
  id: string; version: string; processingState: string; uploadedDate: string;
} {
  return { id, version, processingState, uploadedDate: "2026-06-10T10:00:00Z" };
}

beforeEach(() => {
  for (const m of [...Object.values(ascMocks), ...Object.values(buildMocks)]) m.mockReset();
  ascMocks.getAscAuthFromEnv.mockReturnValue(ENV_AUTH);
  ascMocks.findApp.mockResolvedValue(APP);
});

// ──────────────────────────────────────────────
// appstore_build
// ──────────────────────────────────────────────

describe("appstore_build", () => {
  const handler = findHandler("appstore_build");

  it("runs detect -> schemes -> archive -> export and returns the ipa path", async () => {
    const info = { kind: "xcode", workspacePath: "/proj/App.xcworkspace", buildDir: "/proj" };
    buildMocks.detectIosProject.mockResolvedValue(info);
    buildMocks.listSchemes.mockResolvedValue(["App", "Release"]);
    buildMocks.pickReleaseScheme.mockReturnValue("Release");
    buildMocks.writeExportOptionsPlist.mockResolvedValue("/proj/ExportOptions-abc.plist");
    buildMocks.archiveApp.mockResolvedValue(undefined);
    buildMocks.exportArchive.mockResolvedValue({ ipaPath: "/proj/claude-tf-export/App.ipa" });

    const result = await handler({ projectPath: "/proj" }, dummyCtx);

    expect(buildMocks.detectIosProject).toHaveBeenCalledWith("/proj");
    expect(buildMocks.pickReleaseScheme).toHaveBeenCalledWith(["App", "Release"]);

    const archiveArgs = buildMocks.archiveApp.mock.calls[0][0];
    expect(archiveArgs.projectInfo).toBe(info);
    expect(archiveArgs.scheme).toBe("Release");
    expect(archiveArgs.archivePath).toMatch(/^\/proj\/claude-tf-\d+\.xcarchive$/);
    expect(archiveArgs.auth).toEqual(ENV_AUTH);

    expect(buildMocks.writeExportOptionsPlist).toHaveBeenCalledWith("/proj", { destination: "export" });
    const exportArgs = buildMocks.exportArchive.mock.calls[0][0];
    expect(exportArgs.exportOptionsPlist).toBe("/proj/ExportOptions-abc.plist");
    expect(exportArgs.exportPath).toMatch(/^\/proj\/claude-tf-\d+-export$/);

    expect(result.text).toContain("/proj/claude-tf-export/App.ipa");
    expect(result.text).toContain("Scheme: Release");
    expect(result.text).toMatch(/Duration: [\d.]+s/);
  });

  it("uses the scheme override instead of pickReleaseScheme", async () => {
    buildMocks.detectIosProject.mockResolvedValue({ kind: "xcode", buildDir: "/proj" });
    buildMocks.listSchemes.mockResolvedValue(["App", "My Scheme"]);
    buildMocks.writeExportOptionsPlist.mockResolvedValue("/proj/eo.plist");
    buildMocks.archiveApp.mockResolvedValue(undefined);
    buildMocks.exportArchive.mockResolvedValue({ ipaPath: "/proj/out/App.ipa" });

    await handler({ projectPath: "/proj", scheme: "My Scheme" }, dummyCtx);

    expect(buildMocks.pickReleaseScheme).not.toHaveBeenCalled();
    expect(buildMocks.archiveApp.mock.calls[0][0].scheme).toBe("My Scheme");
  });

  it("rejects a scheme override that is not in the scheme list", async () => {
    buildMocks.detectIosProject.mockResolvedValue({ kind: "xcode", buildDir: "/proj" });
    buildMocks.listSchemes.mockResolvedValue(["App"]);

    await expect(handler({ projectPath: "/proj", scheme: "Nope" }, dummyCtx)).rejects.toMatchObject({
      code: "XCODE_NO_SCHEMES",
    });
    expect(buildMocks.archiveApp).not.toHaveBeenCalled();
  });

  it("short-circuits flutter projects through buildFlutterIpa", async () => {
    buildMocks.detectIosProject.mockResolvedValue({ kind: "flutter", buildDir: "/proj" });
    buildMocks.buildFlutterIpa.mockResolvedValue({ ipaPath: "/proj/build/ios/ipa/app.ipa" });

    const result = await handler({ projectPath: "/proj" }, dummyCtx);

    expect(buildMocks.buildFlutterIpa).toHaveBeenCalledWith("/proj");
    expect(buildMocks.archiveApp).not.toHaveBeenCalled();
    expect(result.text).toContain("/proj/build/ios/ipa/app.ipa");
  });

  it("blocks path traversal in projectPath before any work", async () => {
    await expect(handler({ projectPath: "/proj/../etc" }, dummyCtx)).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_BLOCKED",
    });
    expect(buildMocks.detectIosProject).not.toHaveBeenCalled();
  });

  it("requires a key FILE for xcodebuild (inline PEM is not enough)", async () => {
    ascMocks.getAscAuthFromEnv.mockReturnValue({ ...ENV_AUTH, keyPath: undefined });
    buildMocks.detectIosProject.mockResolvedValue({ kind: "xcode", buildDir: "/proj" });

    await expect(handler({ projectPath: "/proj" }, dummyCtx)).rejects.toMatchObject({
      code: "ASC_KEY_MISSING",
    });
  });
});

// ──────────────────────────────────────────────
// appstore_upload — security validation
// ──────────────────────────────────────────────

describe("appstore_upload", () => {
  const handler = findHandler("appstore_upload");

  it("throws PATH_TRAVERSAL_BLOCKED for traversal in ipaPath", async () => {
    await expect(handler({ ipaPath: "../../etc/app.ipa" }, dummyCtx)).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_BLOCKED",
    });
    expect(buildMocks.uploadIpa).not.toHaveBeenCalled();
  });

  it("rejects non-.ipa paths with ValidationError", async () => {
    await expect(handler({ ipaPath: "/builds/app.apk" }, dummyCtx)).rejects.toThrow(ValidationError);
    expect(buildMocks.uploadIpa).not.toHaveBeenCalled();
  });

  it("uploads with env-resolved credentials and advises polling", async () => {
    buildMocks.uploadIpa.mockResolvedValue(undefined);

    const result = await handler({ ipaPath: "/builds/app.ipa" }, dummyCtx);

    expect(buildMocks.uploadIpa).toHaveBeenCalledWith({
      ipaPath: "/builds/app.ipa",
      keyId: ENV_AUTH.keyId,
      issuerId: ENV_AUTH.issuerId,
    });
    expect(result.text).toContain("5-15 minutes");
    expect(result.text).toContain("appstore_status");
  });
});

// ──────────────────────────────────────────────
// appstore_status
// ──────────────────────────────────────────────

describe("appstore_status", () => {
  const handler = findHandler("appstore_status");

  it("renders a table and suggests re-polling while PROCESSING", async () => {
    ascMocks.getBuilds.mockResolvedValue([
      build("b1", "42", "PROCESSING"),
      build("b2", "41", "VALID"),
    ]);

    const result = await handler({ bundleId: "com.example.app" }, dummyCtx);

    expect(ascMocks.findApp).toHaveBeenCalledWith("com.example.app");
    expect(ascMocks.getBuilds).toHaveBeenCalledWith("app-1", { version: undefined, limit: 5 });
    expect(result.text).toContain("My App");
    expect(result.text).toMatch(/42\s+PROCESSING/);
    expect(result.text).toMatch(/41\s+VALID/);
    expect(result.text).toContain("~30s");
  });

  it("does not suggest re-polling when all builds are processed", async () => {
    ascMocks.getBuilds.mockResolvedValue([build("b2", "41", "VALID")]);

    const result = await handler({ bundleId: "com.example.app" }, dummyCtx);
    expect(result.text).not.toContain("~30s");
  });

  it("validates bundleId and version before any API call", async () => {
    await expect(handler({ bundleId: "bad;id" }, dummyCtx)).rejects.toMatchObject({
      code: "INVALID_BUNDLE_ID",
    });
    await expect(
      handler({ bundleId: "com.example.app", version: "1.2.3; rm" }, dummyCtx),
    ).rejects.toMatchObject({ code: "INVALID_VERSION_STRING" });
    expect(ascMocks.findApp).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// appstore_set_notes
// ──────────────────────────────────────────────

describe("appstore_set_notes", () => {
  const handler = findHandler("appstore_set_notes");

  it("resolves the latest VALID build (skipping PROCESSING ones)", async () => {
    ascMocks.getBuilds.mockResolvedValue([
      build("b1", "42", "PROCESSING"),
      build("b2", "41", "VALID"),
    ]);
    ascMocks.setWhatToTest.mockResolvedValue(undefined);

    const result = await handler({ bundleId: "com.example.app", whatsNew: "Bug fixes" }, dummyCtx);

    expect(ascMocks.setWhatToTest).toHaveBeenCalledWith("b2", "Bug fixes", "en-US");
    expect(result.text).toContain("41");
  });

  it("uses an explicit buildId without listing builds", async () => {
    ascMocks.setWhatToTest.mockResolvedValue(undefined);

    await handler(
      { bundleId: "com.example.app", buildId: "b-9", whatsNew: "Notes", locale: "ru-RU" },
      dummyCtx,
    );

    expect(ascMocks.getBuilds).not.toHaveBeenCalled();
    expect(ascMocks.setWhatToTest).toHaveBeenCalledWith("b-9", "Notes", "ru-RU");
  });

  it("throws TESTFLIGHT_NO_VALID_BUILD when nothing has finished processing", async () => {
    ascMocks.getBuilds.mockResolvedValue([build("b1", "42", "PROCESSING")]);

    await expect(
      handler({ bundleId: "com.example.app", whatsNew: "x" }, dummyCtx),
    ).rejects.toMatchObject({ code: "TESTFLIGHT_NO_VALID_BUILD" });
  });

  it("rejects whatsNew over 4000 characters", async () => {
    await expect(
      handler({ bundleId: "com.example.app", whatsNew: "A".repeat(4001) }, dummyCtx),
    ).rejects.toThrow(ValidationError);
  });
});

// ──────────────────────────────────────────────
// appstore_distribute
// ──────────────────────────────────────────────

describe("appstore_distribute", () => {
  const handler = findHandler("appstore_distribute");

  beforeEach(() => {
    ascMocks.getBuilds.mockResolvedValue([build("b1", "42", "VALID")]);
  });

  it("lists available groups when the requested group is not found", async () => {
    ascMocks.getBetaGroups.mockResolvedValue([
      { id: "g1", name: "Internal Testers", isInternal: true },
      { id: "g2", name: "Beta", isInternal: false },
    ]);

    try {
      await handler({ bundleId: "com.example.app", groupName: "QA" }, dummyCtx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as MobileError).code).toBe("TESTFLIGHT_GROUP_NOT_FOUND");
      expect((e as MobileError).message).toContain("Internal Testers");
      expect((e as MobileError).message).toContain("Beta");
    }
    expect(ascMocks.addBuildToGroup).not.toHaveBeenCalled();
  });

  it("adds the build to an external group and submits for beta review", async () => {
    ascMocks.getBetaGroups.mockResolvedValue([{ id: "g2", name: "Beta", isInternal: false }]);
    ascMocks.addBuildToGroup.mockResolvedValue(undefined);
    ascMocks.submitForBetaReview.mockResolvedValue(undefined);

    const result = await handler({ bundleId: "com.example.app", groupName: "Beta" }, dummyCtx);

    expect(ascMocks.addBuildToGroup).toHaveBeenCalledWith("g2", "b1");
    expect(ascMocks.submitForBetaReview).toHaveBeenCalledWith("b1");
    expect(result.text).toContain("Submitted for external beta review");
  });

  it("does NOT submit internal groups for review", async () => {
    ascMocks.getBetaGroups.mockResolvedValue([{ id: "g1", name: "Internal", isInternal: true }]);
    ascMocks.addBuildToGroup.mockResolvedValue(undefined);

    await handler({ bundleId: "com.example.app", groupName: "Internal" }, dummyCtx);
    expect(ascMocks.submitForBetaReview).not.toHaveBeenCalled();
  });

  it("skips review submission when submitReview=false", async () => {
    ascMocks.getBetaGroups.mockResolvedValue([{ id: "g2", name: "Beta", isInternal: false }]);
    ascMocks.addBuildToGroup.mockResolvedValue(undefined);

    await handler({ bundleId: "com.example.app", groupName: "Beta", submitReview: false }, dummyCtx);
    expect(ascMocks.submitForBetaReview).not.toHaveBeenCalled();
  });

  it("treats an already-submitted review as success", async () => {
    ascMocks.getBetaGroups.mockResolvedValue([{ id: "g2", name: "Beta", isInternal: false }]);
    ascMocks.addBuildToGroup.mockResolvedValue(undefined);
    ascMocks.submitForBetaReview.mockRejectedValue(
      new Error("App Store Connect API 409: build has already been submitted for review"),
    );

    const result = await handler({ bundleId: "com.example.app", groupName: "Beta" }, dummyCtx);
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("already submitted");
  });
});

// ──────────────────────────────────────────────
// appstore_submit
// ──────────────────────────────────────────────

describe("appstore_submit", () => {
  const handler = findHandler("appstore_submit");

  it("submits the latest VALID build for beta review", async () => {
    ascMocks.getBuilds.mockResolvedValue([build("b1", "42", "VALID")]);
    ascMocks.submitForBetaReview.mockResolvedValue(undefined);

    const result = await handler({ bundleId: "com.example.app" }, dummyCtx);

    expect(ascMocks.submitForBetaReview).toHaveBeenCalledWith("b1");
    expect(result.text).toContain("beta review");
  });
});

// ──────────────────────────────────────────────
// store meta — provider "apple" dispatch + testflight_* aliases
// ──────────────────────────────────────────────

describe("store meta — apple provider", () => {
  it("dispatches provider:apple action:status to the appstore handler", async () => {
    ascMocks.getBuilds.mockResolvedValue([build("b1", "42", "VALID")]);

    const result = await storeMeta.handler(
      { action: "status", provider: "apple", bundleId: "com.example.app" },
      dummyCtx,
    );

    expect(ascMocks.findApp).toHaveBeenCalledWith("com.example.app");
    expect(result.text).toContain("42");
  });

  it("rejects apple-only actions for unknown providers", async () => {
    await expect(
      storeMeta.handler({ action: "status", provider: "amazon" }, dummyCtx),
    ).rejects.toThrow(MobileError);
  });

  it("exposes apple in the provider enum and build/status/distribute in actions", () => {
    const props = storeMeta.tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.provider.enum).toContain("apple");
    for (const a of ["build", "status", "distribute", "upload", "set_notes", "submit"]) {
      expect(props.action.enum).toContain(a);
    }
  });

  it("maps testflight_* aliases to the store meta with apple defaults", () => {
    expect(storeAliases.testflight_upload).toEqual({
      tool: "store",
      defaults: { action: "upload", provider: "apple" },
    });
    expect(storeAliases.testflight_build).toEqual({
      tool: "store",
      defaults: { action: "build", provider: "apple" },
    });
    expect(storeAliases.testflight_status.defaults).toEqual({ action: "status", provider: "apple" });
    expect(storeAliases.testflight_set_notes.defaults).toEqual({ action: "set_notes", provider: "apple" });
    expect(storeAliases.testflight_distribute.defaults).toEqual({ action: "distribute", provider: "apple" });
    expect(storeAliases.testflight_submit.defaults).toEqual({ action: "submit", provider: "apple" });
  });

  it("alias defaults resolve through the meta handler (testflight_upload)", async () => {
    buildMocks.uploadIpa.mockResolvedValue(undefined);
    const alias = storeAliases.testflight_upload;

    const result = await storeMeta.handler(
      { ...alias.defaults, ipaPath: "/builds/app.ipa" },
      dummyCtx,
    );

    expect(buildMocks.uploadIpa).toHaveBeenCalledWith({
      ipaPath: "/builds/app.ipa",
      keyId: ENV_AUTH.keyId,
      issuerId: ENV_AUTH.issuerId,
    });
    expect(result.text).toContain("appstore_status");
  });
});
