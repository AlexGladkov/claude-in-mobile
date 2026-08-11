import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./verify-release-checksums.sh", import.meta.url));
const VERSION = "9.9.9";
const PREFIX = `claude-in-mobile-${VERSION}-`;
const PLATFORMS = ["darwin-arm64", "darwin-x86_64"] as const;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface Fixture {
  dir: string;
  formula: string;
  assets: string;
  shas: Record<string, string>;
}

/** Build a consistent fixture: two tarballs, matching sidecars, matching formula. */
function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cim-verify-"));
  const assets = join(dir, "assets");
  mkdirSync(assets);
  const shas: Record<string, string> = {};

  for (const p of PLATFORMS) {
    const content = `binary-bytes-for-${p}`;
    const tar = join(assets, `${PREFIX}${p}.tar.gz`);
    writeFileSync(tar, content);
    const hash = sha256(content);
    shas[p] = hash;
    writeFileSync(`${tar}.sha256`, `${hash}  ${PREFIX}${p}.tar.gz\n`);
  }

  const formula = join(dir, "formula.rb");
  writeFormula(formula, shas["darwin-arm64"], shas["darwin-x86_64"]);
  return { dir, formula, assets, shas };
}

function writeFormula(path: string, armSha: string, intelSha: string): void {
  writeFileSync(
    path,
    [
      "class ClaudeInMobile < Formula",
      `  version "${VERSION}"`,
      "  on_macos do",
      "    on_arm do",
      `      url "https://example/releases/download/v#{version}/${PREFIX.replace(VERSION, "#{version}")}darwin-arm64.tar.gz"`,
      `      sha256 "${armSha}"`,
      "    end",
      "    on_intel do",
      `      url "https://example/releases/download/v#{version}/${PREFIX.replace(VERSION, "#{version}")}darwin-x86_64.tar.gz"`,
      `      sha256 "${intelSha}"`,
      "    end",
      "  end",
      "end",
      "",
    ].join("\n"),
  );
}

function run(fx: Fixture): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, fx.formula, fx.assets, VERSION], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("verify-release-checksums.sh", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it("passes when every tarball == sidecar == formula (per platform)", () => {
    const { code, out } = run(fx);
    expect(code).toBe(0);
    expect(out).toMatch(/All release checksums verified/);
  });

  it("fails when a sidecar hash does not match its tarball", () => {
    writeFileSync(join(fx.assets, `${PREFIX}darwin-arm64.tar.gz.sha256`), `${"0".repeat(64)}  x\n`);
    const { code, out } = run(fx);
    expect(code).toBe(1);
    expect(out).toMatch(/Sidecar mismatch for .*darwin-arm64/);
  });

  it("fails when a sidecar file is missing", () => {
    unlinkSync(join(fx.assets, `${PREFIX}darwin-x86_64.tar.gz.sha256`));
    const { code, out } = run(fx);
    expect(code).toBe(1);
    expect(out).toMatch(/Sidecar missing: .*darwin-x86_64/);
  });

  it("fails when the formula sha for a platform does not match the tarball", () => {
    writeFormula(fx.formula, "a".repeat(64), fx.shas["darwin-x86_64"]);
    const { code, out } = run(fx);
    expect(code).toBe(1);
    expect(out).toMatch(/Formula mismatch for darwin-arm64/);
  });

  it("fails on a mis-bind: correct hashes swapped between platform blocks", () => {
    // Each hash is present in the formula, but bound to the WRONG platform.
    // The old presence-anywhere grep would pass; the platform-bound check fails.
    writeFormula(fx.formula, fx.shas["darwin-x86_64"], fx.shas["darwin-arm64"]);
    const { code, out } = run(fx);
    expect(code).toBe(1);
    expect(out).toMatch(/Formula mismatch/);
  });

  it("fails when no tarballs are present", () => {
    for (const p of PLATFORMS) {
      unlinkSync(join(fx.assets, `${PREFIX}${p}.tar.gz`));
      unlinkSync(join(fx.assets, `${PREFIX}${p}.tar.gz.sha256`));
    }
    const { code, out } = run(fx);
    expect(code).toBe(1);
    expect(out).toMatch(/No .* assets found/);
  });
});
