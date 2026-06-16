/**
 * Architecture invariants enforced as tests.
 *
 * Rules from docs/adr/0001-microkernel-architecture.md:
 *   1. kernel/** must not import from plugins/**
 *   2. kernel/** must not import from any platform-specific module
 *      (adapters/, adb/, ios/, desktop/, browser/, aurora/, device-manager.ts)
 *   3. plugins/<a>/** must not import from plugins/<b>/**
 *   4. plugins/** must not import from device-manager.ts (legacy facade)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

interface FileImport {
  file: string;
  imports: string[];
}

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, files);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function extractImports(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import\s+(?:[\s\S]*?from\s+)?|export\s+[\s\S]*?from\s+)["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function loadAll(): FileImport[] {
  return walk(SRC).map((f) => ({
    file: relative(SRC, f),
    imports: extractImports(f),
  }));
}

// aurora/ moved to @claude-in-mobile/plugin-aurora (4.0.0 physical split).
const PLATFORM_DIRS = ["adapters/", "adb/", "ios/"];

describe("architecture", () => {
  const all = loadAll();

  it("kernel/** must not import from plugins/**", () => {
    const violations = all
      .filter((f) => f.file.startsWith("kernel/"))
      .flatMap((f) =>
        f.imports
          .filter((imp) => imp.includes("plugins/") || imp.includes("/plugins"))
          .map((imp) => `${f.file} → ${imp}`)
      );
    expect(violations).toEqual([]);
  });

  it("kernel/** must not import from platform modules or device-manager", () => {
    const violations = all
      .filter((f) => f.file.startsWith("kernel/"))
      .flatMap((f) =>
        f.imports
          .filter(
            (imp) =>
              PLATFORM_DIRS.some((p) => imp.includes(p)) ||
              imp.includes("device-manager")
          )
          .map((imp) => `${f.file} → ${imp}`)
      );
    expect(violations).toEqual([]);
  });

  it("plugins/<a>/** must not import from plugins/<b>/**", () => {
    const violations: string[] = [];
    for (const f of all) {
      const m = f.file.match(/^plugins\/([^/]+)\//);
      if (!m) continue;
      const ownPluginId = m[1];
      for (const imp of f.imports) {
        const im = imp.match(/plugins\/([^/]+)/);
        if (im && im[1] !== ownPluginId) {
          violations.push(`${f.file} → ${imp}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("plugins/** must not import device-manager.ts (legacy facade)", () => {
    const violations = all
      .filter((f) => f.file.startsWith("plugins/"))
      .flatMap((f) =>
        f.imports
          .filter((imp) => imp.includes("device-manager"))
          .map((imp) => `${f.file} → ${imp}`)
      );
    expect(violations).toEqual([]);
  });
});
