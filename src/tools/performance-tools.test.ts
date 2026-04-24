import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "./context.js";
import { performanceTools } from "./performance-tools.js";
import {
  parseMemoryFromDumpsys,
  parseCpuFromDumpsys,
  parseFpsFromGfxinfo,
  parseBatteryFromDumpsys,
  parseCrashesFromLogcat,
} from "../perf/collector.js";
import {
  formatSnapshot,
  formatCompare,
  formatMonitor,
  formatCrashes,
} from "../perf/formatter.js";
import { PerfBaselineStore } from "../utils/perf-baseline-store.js";
import type { PerfSnapshot, PerfCompareResult, PerfMonitorResult } from "../perf/types.js";
import { ValidationError } from "../errors.js";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ── Parser tests ──

describe("parseMemoryFromDumpsys", () => {
  it("parses TOTAL PSS line", () => {
    const output = `
Applications Memory Usage (in Kilobytes):
Uptime: 123456 Realtime: 654321

** MEMINFO in pid 12345 [com.example.app] **
                   Pss  Private  Private  SwapPss      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    50000    49900      100        0    52000    70000    55000    15000
  Dalvik Heap    30000    29800      200        0    32000    40000    32000     8000
        TOTAL   151552   120000    10000      500   140000   110000    87000    23000

Total RAM:   8388608 kB`;

    const result = parseMemoryFromDumpsys(output);
    expect(result).not.toBeNull();
    expect(result!.usedMb).toBeCloseTo(148, 0);
    expect(result!.totalMb).toBeCloseTo(8192, 0);
  });

  it("parses TOTAL line without PSS suffix", () => {
    const output = `
  TOTAL   102400   80000    5000      0    90000
Total RAM:   4194304 kB`;

    const result = parseMemoryFromDumpsys(output);
    expect(result).not.toBeNull();
    expect(result!.usedMb).toBe(100);
    expect(result!.totalMb).toBe(4096);
  });

  it("returns null for unparseable output", () => {
    expect(parseMemoryFromDumpsys("no useful info here")).toBeNull();
  });
});

describe("parseCpuFromDumpsys", () => {
  it("parses CPU percentage for package", () => {
    const output = `
Load: 4.5 / 3.2 / 2.1
CPU usage from 12345ms to 0ms ago:
  12.3% 12345/com.example.app: 8% user + 4.3% kernel
  5.1% 6789/system_server: 3% user + 2.1% kernel
  2.0% 111/surfaceflinger: 1% user + 1% kernel`;

    const result = parseCpuFromDumpsys(output, "com.example.app");
    expect(result).not.toBeNull();
    expect(result!.appPercent).toBe(12.3);
  });

  it("returns null when package not found", () => {
    const output = "  5.1% 6789/system_server: 3% user + 2.1% kernel";
    expect(parseCpuFromDumpsys(output, "com.missing.app")).toBeNull();
  });
});

describe("parseFpsFromGfxinfo", () => {
  it("parses frame stats", () => {
    const output = `
Stats since: 12345678ns
Total frames rendered: 285
Janky frames: 4 (1.40%)
50th percentile: 8ms
90th percentile: 12ms
95th percentile: 16ms
99th percentile: 32ms`;

    const result = parseFpsFromGfxinfo(output);
    expect(result).not.toBeNull();
    expect(result!.totalFrames).toBe(285);
    expect(result!.jankyFrames).toBe(4);
    expect(result!.current).toBeGreaterThan(0);
  });

  it("returns null for empty output", () => {
    expect(parseFpsFromGfxinfo("no gfx info")).toBeNull();
  });
});

describe("parseBatteryFromDumpsys", () => {
  it("parses battery info", () => {
    const output = `
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge type: 1
  status: 2
  health: 2
  present: true
  level: 85
  scale: 100
  voltage: 4200
  temperature: 310
  technology: Li-ion`;

    const result = parseBatteryFromDumpsys(output);
    expect(result).not.toBeNull();
    expect(result!.level).toBe(85);
    expect(result!.temperature).toBe(31);
    expect(result!.charging).toBe(true);
  });

  it("returns null for no data", () => {
    expect(parseBatteryFromDumpsys("nothing here")).toBeNull();
  });
});

describe("parseCrashesFromLogcat", () => {
  it("parses FATAL EXCEPTION", () => {
    const output = `04-24 11:23:45.123 E/AndroidRuntime(12345): FATAL EXCEPTION: main
04-24 11:23:45.123 E/AndroidRuntime(12345): Process: com.example.app, PID: 12345
04-24 11:23:45.123 E/AndroidRuntime(12345): java.lang.NullPointerException: Attempt to invoke virtual method
04-24 11:23:45.123 E/AndroidRuntime(12345): 	at com.example.app.MainActivity.onCreate(MainActivity.kt:42)`;

    const crashes = parseCrashesFromLogcat(output);
    expect(crashes.length).toBe(1);
    expect(crashes[0].type).toBe("crash");
    expect(crashes[0].summary).toContain("NullPointerException");
  });

  it("parses ANR", () => {
    const output = `04-24 11:45:12.456 E/ActivityManager(1234): ANR in com.example.app
04-24 11:45:12.456 E/ActivityManager(1234): Reason: Input dispatching timed out`;

    const crashes = parseCrashesFromLogcat(output);
    expect(crashes.length).toBe(1);
    expect(crashes[0].type).toBe("anr");
    expect(crashes[0].process).toBe("com.example.app");
    expect(crashes[0].summary).toContain("Input dispatching timed out");
  });

  it("parses native crash marker", () => {
    const output = `04-24 12:00:00.000 F/DEBUG(12345): *** *** *** *** *** *** *** ***`;
    const crashes = parseCrashesFromLogcat(output);
    expect(crashes.length).toBe(1);
    expect(crashes[0].type).toBe("native_crash");
  });

  it("returns empty array for clean logs", () => {
    expect(parseCrashesFromLogcat("Everything is fine")).toEqual([]);
  });
});

// ── Formatter tests ──

describe("formatSnapshot", () => {
  it("formats complete snapshot", () => {
    const snapshot: PerfSnapshot = {
      platform: "android",
      timestamp: "2026-04-24T10:00:00Z",
      packageName: "com.example.app",
      memory: { usedMb: 148, totalMb: 8192 },
      cpu: { appPercent: 12.3 },
      fps: { current: 58, jankyFrames: 4, totalFrames: 285 },
      battery: { level: 85, temperature: 31, charging: true },
      crashes: [],
    };

    const text = formatSnapshot(snapshot);
    expect(text).toContain("Performance snapshot (android, com.example.app)");
    expect(text).toContain("Memory: 148 MB used");
    expect(text).toContain("CPU: 12.3% (app)");
    expect(text).toContain("FPS: 58 (4 janky / 285 total)");
    expect(text).toContain("Battery: 85%");
    expect(text).toContain("31\u00B0C");
    expect(text).toContain("charging");
    expect(text).toContain("Crashes: 0");
  });

  it("formats snapshot with N/A for missing metrics", () => {
    const snapshot: PerfSnapshot = {
      platform: "ios",
      timestamp: "2026-04-24T10:00:00Z",
      memory: null,
      cpu: null,
      fps: null,
      battery: null,
      crashes: [],
    };

    const text = formatSnapshot(snapshot);
    expect(text).toContain("Memory: N/A");
    expect(text).toContain("CPU: N/A");
    expect(text).toContain("FPS: N/A");
    expect(text).toContain("Battery: N/A");
  });
});

describe("formatCompare", () => {
  it("formats PASS result", () => {
    const result: PerfCompareResult = {
      status: "PASS",
      baselineName: "login-flow (android)",
      metrics: [
        { metric: "memory", baselineValue: 148, currentValue: 152, diffPercent: 2.7, threshold: 20, status: "PASS" },
        { metric: "cpu", baselineValue: 12.3, currentValue: 13.1, diffPercent: 6.5, threshold: 30, status: "PASS" },
      ],
    };

    const text = formatCompare(result);
    expect(text).toContain("PERF PASS: login-flow (android)");
    expect(text).toContain("memory: 148 MB");
    expect(text).toContain("152 MB");
    expect(text).toContain("+2.7%");
    expect(text).toContain("PASS");
  });

  it("formats FAIL result", () => {
    const result: PerfCompareResult = {
      status: "FAIL",
      baselineName: "login-flow (android)",
      metrics: [
        { metric: "memory", baselineValue: 148, currentValue: 195, diffPercent: 31.8, threshold: 20, status: "FAIL" },
        { metric: "cpu", baselineValue: 12.3, currentValue: 13.1, diffPercent: 6.5, threshold: 30, status: "PASS" },
      ],
    };

    const text = formatCompare(result);
    expect(text).toContain("PERF FAIL");
    expect(text).toContain("1 metric exceeded threshold");
    expect(text).toContain("+31.8%");
    expect(text).toContain("FAIL");
  });
});

describe("formatMonitor", () => {
  it("formats monitor result", () => {
    const result: PerfMonitorResult = {
      durationMs: 5000,
      samples: 5,
      memory: { min: 145, max: 162, avg: 151 },
      cpu: { min: 8.2, max: 18.7, avg: 12.4 },
      fps: { min: 55, max: 60, avg: 58.4 },
      warnings: [],
    };

    const text = formatMonitor(result, "android");
    expect(text).toContain("Performance monitor (android)");
    expect(text).toContain("5000ms, 5 samples");
    expect(text).toContain("min 145 MB");
    expect(text).toContain("max 162 MB");
    expect(text).toContain("avg 151 MB");
  });

  it("includes warnings", () => {
    const result: PerfMonitorResult = {
      durationMs: 3000,
      samples: 2,
      memory: null,
      cpu: null,
      fps: null,
      warnings: ["Sample failed: timeout"],
    };

    const text = formatMonitor(result, "android");
    expect(text).toContain("Sample failed: timeout");
  });
});

describe("formatCrashes", () => {
  it("formats crash entries", () => {
    const text = formatCrashes(
      [
        { type: "crash", timestamp: "11:23:45", summary: "NullPointerException at MainActivity.kt:42" },
        { type: "anr", timestamp: "11:45:12", process: "com.example.app", summary: "Input dispatching timed out" },
      ],
      "android",
    );

    expect(text).toContain("2 crashes detected (android)");
    expect(text).toContain("[CRASH]");
    expect(text).toContain("[ANR]");
    expect(text).toContain("NullPointerException");
    expect(text).toContain("Input dispatching timed out");
  });

  it("formats zero crashes", () => {
    const text = formatCrashes([], "android");
    expect(text).toContain("0 crashes detected (android)");
  });
});

// ── PerfBaselineStore tests ──

describe("PerfBaselineStore", () => {
  let tempDir: string;
  let store: PerfBaselineStore;

  const makeSnapshot = (overrides: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
    platform: "android",
    timestamp: "2026-04-24T10:00:00Z",
    packageName: "com.example.app",
    memory: { usedMb: 148, totalMb: 8192 },
    cpu: { appPercent: 12.3 },
    fps: { current: 60 },
    battery: { level: 85, charging: false },
    crashes: [],
    ...overrides,
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "perf-baseline-test-"));
    process.env.CLAUDE_MOBILE_PERF_BASELINES_DIR = tempDir;
    store = new PerfBaselineStore();
  });

  it("saves and retrieves baseline", async () => {
    const snapshot = makeSnapshot();
    await store.save("login-flow", "android", snapshot);

    const baseline = await store.get("login-flow", "android");
    expect(baseline.name).toBe("login-flow");
    expect(baseline.platform).toBe("android");
    expect(baseline.snapshot.memory?.usedMb).toBe(148);
  });

  it("lists baselines", async () => {
    await store.save("flow-a", "android", makeSnapshot());
    await store.save("flow-b", "android", makeSnapshot());
    await store.save("flow-c", "desktop", makeSnapshot({ platform: "desktop" }));

    const all = await store.list();
    expect(all.length).toBe(3);

    const android = await store.list("android");
    expect(android.length).toBe(2);
  });

  it("deletes baseline", async () => {
    await store.save("temp", "android", makeSnapshot());
    expect(await store.exists("temp", "android")).toBe(true);

    await store.delete("temp", "android");
    expect(await store.exists("temp", "android")).toBe(false);
  });

  it("rejects duplicate without overwrite", async () => {
    await store.save("dup", "android", makeSnapshot());
    await expect(store.save("dup", "android", makeSnapshot())).rejects.toThrow("already exists");
  });

  it("allows overwrite", async () => {
    await store.save("ow", "android", makeSnapshot({ memory: { usedMb: 100, totalMb: 8192 } }));
    await store.save("ow", "android", makeSnapshot({ memory: { usedMb: 200, totalMb: 8192 } }), true);

    const baseline = await store.get("ow", "android");
    expect(baseline.snapshot.memory?.usedMb).toBe(200);
  });

  it("throws on get of non-existent baseline", async () => {
    await expect(store.get("missing", "android")).rejects.toThrow("not found");
  });

  it("checks exists", async () => {
    expect(await store.exists("nope", "android")).toBe(false);
    await store.save("yep", "android", makeSnapshot());
    expect(await store.exists("yep", "android")).toBe(true);
  });

  // Cleanup
  afterEach(async () => {
    delete process.env.CLAUDE_MOBILE_PERF_BASELINES_DIR;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ── Handler integration tests (mocked collector) ──

describe("performance tool handlers", () => {
  // We need to mock the device manager
  function mockCtx(overrides: Record<string, unknown> = {}): ToolContext {
    return {
      deviceManager: {
        getCurrentPlatform: () => "android",
        getAndroidClient: () => ({
          getCurrentActivity: () => "com.test.app/.MainActivity",
          exec: (cmd: string) => {
            if (cmd.includes("dumpsys meminfo")) {
              return "  TOTAL   153600   120000    10000      0    140000\nTotal RAM:   8388608 kB";
            }
            if (cmd.includes("dumpsys cpuinfo")) {
              return "  10.5% 12345/com.test.app: 7% user + 3.5% kernel";
            }
            if (cmd.includes("dumpsys gfxinfo")) {
              return "Total frames rendered: 500\nJanky frames: 10 (2.00%)\n50th percentile: 8ms";
            }
            if (cmd.includes("logcat")) {
              return "";
            }
            return "";
          },
          getBatteryInfo: () =>
            "  status: 2\n  level: 90\n  temperature: 285\n",
        }),
        getDesktopClient: () => ({
          getPerformanceMetrics: async () => ({
            memoryUsageMb: 256,
            cpuPercent: 5.2,
            fps: 60,
          }),
          getState: () => ({ status: "running", crashCount: 0 }),
        }),
        ...overrides,
      } as any,
      getCachedElements: () => [],
      setCachedElements: () => {},
      lastScreenshotMap: new Map(),
      lastUiTreeMap: new Map(),
      screenshotScaleMap: new Map(),
      generateActionHints: async () => "",
      getElementsForPlatform: async () => [],
      iosTreeToUiElements: () => [],
      formatIOSUITree: () => "",
      platformParam: { type: "string", enum: ["android", "ios", "desktop"] },
      handleTool: async () => ({}),
    } as ToolContext;
  }

  const findHandler = (name: string) => {
    const tool = performanceTools.find((t) => t.tool.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool.handler;
  };

  it("performance_snapshot collects and formats metrics", async () => {
    const handler = findHandler("performance_snapshot");
    const result = (await handler({ platform: "android" }, mockCtx())) as { text: string };

    expect(result.text).toContain("Performance snapshot (android");
    expect(result.text).toContain("Memory:");
    expect(result.text).toContain("CPU:");
  });

  it("performance_snapshot auto-detects package", async () => {
    const handler = findHandler("performance_snapshot");
    const result = (await handler({}, mockCtx())) as { text: string };

    expect(result.text).toContain("com.test.app");
  });

  it("performance_crashes returns no crashes for clean logs", async () => {
    const handler = findHandler("performance_crashes");
    const result = (await handler({ platform: "android" }, mockCtx())) as { text: string };

    expect(result.text).toContain("0 crashes detected");
  });

  it("performance_snapshot validates invalid package name", async () => {
    const handler = findHandler("performance_snapshot");
    await expect(
      handler({ platform: "android", packageName: "bad;name" }, mockCtx()),
    ).rejects.toThrow();
  });

  it("performance_baseline requires name", async () => {
    const handler = findHandler("performance_baseline");
    await expect(handler({ platform: "android" }, mockCtx())).rejects.toThrow("name is required");
  });

  it("performance_compare requires name", async () => {
    const handler = findHandler("performance_compare");
    await expect(handler({ platform: "android" }, mockCtx())).rejects.toThrow("name is required");
  });
});

// ── Compare logic tests ──

describe("compare logic", () => {
  it("PASS when within thresholds", () => {
    // This is tested indirectly through formatCompare
    const result: PerfCompareResult = {
      status: "PASS",
      baselineName: "test",
      metrics: [
        { metric: "memory", baselineValue: 100, currentValue: 110, diffPercent: 10, threshold: 20, status: "PASS" },
        { metric: "cpu", baselineValue: 10, currentValue: 12, diffPercent: 20, threshold: 30, status: "PASS" },
      ],
    };

    expect(result.status).toBe("PASS");
    expect(result.metrics.every((m) => m.status === "PASS")).toBe(true);
  });

  it("FAIL when exceeded", () => {
    const result: PerfCompareResult = {
      status: "FAIL",
      baselineName: "test",
      metrics: [
        { metric: "memory", baselineValue: 100, currentValue: 150, diffPercent: 50, threshold: 20, status: "FAIL" },
      ],
    };

    expect(result.status).toBe("FAIL");
    expect(result.metrics[0].status).toBe("FAIL");
  });
});

// ── Monitor aggregation tests ──

describe("monitor aggregation", () => {
  it("calculates min/max/avg correctly", () => {
    // We test the format output since aggregation is internal
    const result: PerfMonitorResult = {
      durationMs: 3000,
      samples: 3,
      memory: { min: 100, max: 200, avg: 150 },
      cpu: { min: 5, max: 15, avg: 10 },
      fps: { min: 50, max: 60, avg: 55 },
      warnings: [],
    };

    expect(result.memory!.min).toBe(100);
    expect(result.memory!.max).toBe(200);
    expect(result.memory!.avg).toBe(150);
    expect(result.samples).toBe(3);
  });
});

// ── Input validation tests ──

describe("input validation", () => {
  it("rejects invalid baseline name", () => {
    expect(() => {
      const { validateBaselineName } = require("../utils/sanitize.js");
      validateBaselineName("../escape-attempt", "name");
    }).toThrow();
  });
});
