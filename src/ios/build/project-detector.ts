/**
 * Detect what kind of iOS project lives in a directory and resolve the
 * workspace/project xcodebuild should be pointed at.
 *
 * Detection order (first match wins):
 *   1. flutter       — pubspec.yaml + ios/
 *   2. react-native  — package.json with a react-native dep + ios/*.xcworkspace
 *   3. kmp           — iosApp/*.xcodeproj (Kotlin Multiplatform layout)
 *   4. xcode         — *.xcworkspace (preferred) or *.xcodeproj in the dir itself
 */

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { MobileError } from "../../errors.js";
import { validatePath } from "../../utils/sanitize.js";
import { XCODE } from "../../constants/timeouts.js";
import { runTool } from "./exec.js";
import { classifyXcodeError } from "./classify-build-error.js";

export type ProjectKind = "flutter" | "react-native" | "kmp" | "xcode";

export interface ProjectInfo {
  kind: ProjectKind;
  /** Absolute path to *.xcworkspace, when one exists (takes priority). */
  workspacePath?: string;
  /** Absolute path to *.xcodeproj, when no workspace is available. */
  projectPath?: string;
  /** Directory xcodebuild/flutter should run relative to. */
  buildDir: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Bundles (.xcworkspace/.xcodeproj) are directories; sorted for determinism. */
async function findByExtension(dir: string, extension: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(extension)).sort();
  } catch {
    return [];
  }
}

async function hasReactNativeDep(packageJsonPath: string): Promise<boolean> {
  try {
    const raw = await readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.["react-native"] ?? pkg.devDependencies?.["react-native"]);
  } catch {
    return false;
  }
}

export async function detectIosProject(dir: string): Promise<ProjectInfo> {
  validatePath(dir, "project directory");

  // 1. Flutter: pubspec.yaml + ios/
  if ((await exists(join(dir, "pubspec.yaml"))) && (await isDirectory(join(dir, "ios")))) {
    const [workspace] = await findByExtension(join(dir, "ios"), ".xcworkspace");
    return {
      kind: "flutter",
      workspacePath: workspace ? join(dir, "ios", workspace) : undefined,
      buildDir: dir,
    };
  }

  // 2. React Native: package.json with react-native dep + ios/*.xcworkspace
  if (
    (await isDirectory(join(dir, "ios"))) &&
    (await hasReactNativeDep(join(dir, "package.json")))
  ) {
    const [workspace] = await findByExtension(join(dir, "ios"), ".xcworkspace");
    if (workspace) {
      return {
        kind: "react-native",
        workspacePath: join(dir, "ios", workspace),
        buildDir: join(dir, "ios"),
      };
    }
  }

  // 3. KMP: iosApp/*.xcodeproj (CocoaPods setups also have iosApp/*.xcworkspace)
  if (await isDirectory(join(dir, "iosApp"))) {
    const iosAppDir = join(dir, "iosApp");
    const [workspace] = await findByExtension(iosAppDir, ".xcworkspace");
    const [project] = await findByExtension(iosAppDir, ".xcodeproj");
    if (workspace || project) {
      return {
        kind: "kmp",
        workspacePath: workspace ? join(iosAppDir, workspace) : undefined,
        projectPath: !workspace && project ? join(iosAppDir, project) : undefined,
        buildDir: iosAppDir,
      };
    }
  }

  // 4. Plain Xcode project in the directory itself.
  const [workspace] = await findByExtension(dir, ".xcworkspace");
  if (workspace) {
    return { kind: "xcode", workspacePath: join(dir, workspace), buildDir: dir };
  }
  const [project] = await findByExtension(dir, ".xcodeproj");
  if (project) {
    return { kind: "xcode", projectPath: join(dir, project), buildDir: dir };
  }

  throw new MobileError(
    `No iOS project found in ${dir}. Expected pubspec.yaml + ios/ (Flutter), ` +
      `a react-native package.json + ios/*.xcworkspace, iosApp/*.xcodeproj (KMP), ` +
      `or a *.xcworkspace / *.xcodeproj.`,
    "IOS_PROJECT_NOT_FOUND",
  );
}

/** `-workspace <ws>` or `-project <proj>` argv slice for xcodebuild. */
export function xcodeTargetArgs(info: ProjectInfo): string[] {
  if (info.workspacePath) return ["-workspace", info.workspacePath];
  if (info.projectPath) return ["-project", info.projectPath];
  throw new MobileError(
    "Project has neither a .xcworkspace nor a .xcodeproj to point xcodebuild at.",
    "IOS_PROJECT_NOT_FOUND",
  );
}

export async function listSchemes(info: ProjectInfo): Promise<string[]> {
  const args = ["-list", "-json", ...xcodeTargetArgs(info)];
  const result = await runTool("xcodebuild", args, { timeoutMs: XCODE.LIST_TIMEOUT_MS });
  if (!result.ok) {
    if (result.timedOut) {
      throw new MobileError(
        `xcodebuild -list timed out after ${XCODE.LIST_TIMEOUT_MS}ms`,
        "XCODE_LIST_TIMEOUT",
      );
    }
    throw classifyXcodeError(result.stderr, "xcodebuild -list");
  }

  let parsed: { workspace?: { schemes?: string[] }; project?: { schemes?: string[] } };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new MobileError(
      `xcodebuild -list returned invalid JSON: ${result.stdout.trim().slice(0, 200)}`,
      "XCODE_LIST_PARSE_ERROR",
    );
  }
  return parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
}

/**
 * Pick the scheme to archive: exact "Release" > "<x>-Release" suffix > first
 * scheme that is neither a test nor a debug scheme > first scheme.
 */
export function pickReleaseScheme(schemes: string[]): string {
  if (schemes.length === 0) {
    throw new MobileError(
      "No schemes found. Mark a scheme as Shared in Xcode (Manage Schemes).",
      "XCODE_NO_SCHEMES",
    );
  }
  const exact = schemes.find((s) => s === "Release");
  if (exact) return exact;
  const suffixed = schemes.find((s) => s.endsWith("-Release"));
  if (suffixed) return suffixed;
  const nonTest = schemes.find((s) => !/Tests|Debug/.test(s));
  return nonTest ?? schemes[0];
}
