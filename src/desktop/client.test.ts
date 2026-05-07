import { describe, it, expect } from "vitest";
import { normalizeLaunchOptions } from "./client.js";
import { MobileError } from "../errors.js";

// ─────────────────────────────────────────────────────────────
// normalizeLaunchOptions
// ─────────────────────────────────────────────────────────────

describe("normalizeLaunchOptions — mode: gradle", () => {
  it("returns gradle LaunchOptions when mode and projectPath are provided", () => {
    const result = normalizeLaunchOptions({
      mode: "gradle",
      projectPath: "/home/user/my-project",
    });
    expect(result.mode).toBe("gradle");
    if (result.mode === "gradle") {
      expect(result.projectPath).toBe("/home/user/my-project");
    }
  });

  it("preserves optional task and jvmArgs fields", () => {
    const result = normalizeLaunchOptions({
      mode: "gradle",
      projectPath: "/home/user/my-project",
      task: "runDesktop",
      jvmArgs: ["-Xmx512m"],
      env: { FOO: "bar" },
    });
    expect(result.mode).toBe("gradle");
    if (result.mode === "gradle") {
      expect(result.task).toBe("runDesktop");
      expect(result.jvmArgs).toEqual(["-Xmx512m"]);
      expect(result.env).toEqual({ FOO: "bar" });
    }
  });

  it("throws INVALID_LAUNCH_OPTIONS when projectPath is missing", () => {
    expect(() => normalizeLaunchOptions({ mode: "gradle" })).toThrowError(
      expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }),
    );
  });

  it("throws INVALID_LAUNCH_OPTIONS when gradle receives bundleId (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "gradle",
        projectPath: "/path",
        bundleId: "com.example.app",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws INVALID_LAUNCH_OPTIONS when gradle receives appPath (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "gradle",
        projectPath: "/path",
        appPath: "/Applications/MyApp.app",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws INVALID_LAUNCH_OPTIONS when gradle receives pid (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "gradle",
        projectPath: "/path",
        pid: 1234,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });
});

describe("normalizeLaunchOptions — mode: bundle", () => {
  it("returns bundle LaunchOptions when bundleId is provided", () => {
    const result = normalizeLaunchOptions({
      mode: "bundle",
      bundleId: "com.apple.TextEdit",
    });
    expect(result.mode).toBe("bundle");
    if (result.mode === "bundle") {
      expect(result.bundleId).toBe("com.apple.TextEdit");
    }
  });

  it("returns bundle LaunchOptions when appPath is provided", () => {
    const result = normalizeLaunchOptions({
      mode: "bundle",
      appPath: "/Applications/TextEdit.app",
    });
    expect(result.mode).toBe("bundle");
    if (result.mode === "bundle") {
      expect(result.appPath).toBe("/Applications/TextEdit.app");
    }
  });

  it("throws INVALID_LAUNCH_OPTIONS when neither bundleId nor appPath is provided", () => {
    expect(() => normalizeLaunchOptions({ mode: "bundle" })).toThrowError(
      expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }),
    );
  });

  it("throws INVALID_LAUNCH_OPTIONS when bundle receives pid (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "bundle",
        bundleId: "com.example.app",
        pid: 999,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws INVALID_LAUNCH_OPTIONS when bundle receives projectPath (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "bundle",
        bundleId: "com.example.app",
        projectPath: "/path/to/project",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });
});

describe("normalizeLaunchOptions — mode: attach", () => {
  it("returns attach LaunchOptions when pid is provided", () => {
    const result = normalizeLaunchOptions({ mode: "attach", pid: 42 });
    expect(result.mode).toBe("attach");
    if (result.mode === "attach") {
      expect(result.pid).toBe(42);
    }
  });

  it("throws INVALID_LAUNCH_OPTIONS when pid is missing", () => {
    expect(() => normalizeLaunchOptions({ mode: "attach" })).toThrowError(
      expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }),
    );
  });

  it("throws INVALID_LAUNCH_OPTIONS when attach receives bundleId (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "attach",
        pid: 42,
        bundleId: "com.example.app",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws INVALID_LAUNCH_OPTIONS when attach receives appPath (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "attach",
        pid: 42,
        appPath: "/Applications/App.app",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws INVALID_LAUNCH_OPTIONS when attach receives projectPath (conflicting)", () => {
    expect(() =>
      normalizeLaunchOptions({
        mode: "attach",
        pid: 42,
        projectPath: "/path/to/project",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });
});

describe("normalizeLaunchOptions — mode: companion-only", () => {
  it("returns companion-only LaunchOptions", () => {
    const result = normalizeLaunchOptions({ mode: "companion-only" });
    expect(result.mode).toBe("companion-only");
  });

  it("returns companion-only when no fields are provided (inference)", () => {
    const result = normalizeLaunchOptions({});
    expect(result.mode).toBe("companion-only");
  });
});

describe("normalizeLaunchOptions — mode inference (legacy / no explicit mode)", () => {
  it("infers gradle when projectPath is provided without mode", () => {
    const result = normalizeLaunchOptions({ projectPath: "/home/user/project" });
    expect(result.mode).toBe("gradle");
    if (result.mode === "gradle") {
      expect(result.projectPath).toBe("/home/user/project");
    }
  });

  it("infers companion-only when no fields are provided", () => {
    const result = normalizeLaunchOptions({});
    expect(result.mode).toBe("companion-only");
  });
});

describe("normalizeLaunchOptions — unknown mode", () => {
  it("throws INVALID_LAUNCH_OPTIONS for an unknown mode string", () => {
    expect(() =>
      normalizeLaunchOptions({ mode: "teleport" as any }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_LAUNCH_OPTIONS" }));
  });

  it("throws MobileError for an unknown mode", () => {
    expect(() =>
      normalizeLaunchOptions({ mode: "teleport" as any }),
    ).toThrow(MobileError);
  });

  it("error message mentions the bad mode value", () => {
    try {
      normalizeLaunchOptions({ mode: "teleport" as any });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("teleport");
    }
  });
});
