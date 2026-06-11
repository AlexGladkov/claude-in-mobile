/**
 * xcodebuild archive / export + `flutter build ipa` — argv form only, no shell.
 *
 * Failures are routed through classifyXcodeError: callers never see the raw
 * xcodebuild log, only a typed error whose message carries at most the last
 * 200 chars of the REDACTED stderr (see classify-build-error.ts).
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { MobileError } from "../../errors.js";
import { validatePath } from "../../utils/sanitize.js";
import { XCODE } from "../../constants/timeouts.js";
import { runTool } from "./exec.js";
import { classifyXcodeError } from "./classify-build-error.js";
import { xcodeTargetArgs, type ProjectInfo } from "./project-detector.js";

export interface AscApiAuth {
  /** App Store Connect API key ID (e.g. "AB12CD34EF"). */
  keyId: string;
  /** Issuer ID (UUID) from the ASC "Keys" page. */
  issuerId: string;
  /** Absolute path to the AuthKey_*.p8 file. */
  keyPath: string;
}

/** keyId is 10 alnum chars, issuerId a UUID — both end up in argv (safe), the
 *  regex just catches copy-paste garbage early with a clear error. */
const CREDENTIAL_RE = /^[A-Za-z0-9-]+$/;

function validateAuth(auth: AscApiAuth): void {
  validatePath(auth.keyPath, "authentication key path");
  if (!CREDENTIAL_RE.test(auth.keyId) || !CREDENTIAL_RE.test(auth.issuerId)) {
    throw new MobileError(
      "Invalid App Store Connect credentials: keyId/issuerId must be alphanumeric (UUID allowed).",
      "INVALID_ASC_CREDENTIALS",
    );
  }
}

function authArgs(auth: AscApiAuth): string[] {
  return [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath", auth.keyPath,
    "-authenticationKeyID", auth.keyId,
    "-authenticationKeyIssuerID", auth.issuerId,
  ];
}

async function findIpa(dir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dir);
    const ipa = entries.filter((name) => name.endsWith(".ipa")).sort()[0];
    return ipa ? join(dir, ipa) : undefined;
  } catch {
    return undefined;
  }
}

export async function archiveApp(options: {
  projectInfo: ProjectInfo;
  scheme: string;
  configuration?: string;
  archivePath: string;
  auth: AscApiAuth;
}): Promise<void> {
  const { projectInfo, scheme, configuration = "Release", archivePath, auth } = options;
  validatePath(archivePath, "archive path");
  validateAuth(auth);
  if (!scheme.trim()) {
    throw new MobileError("Scheme must not be empty", "XCODE_NO_SCHEMES");
  }

  const args = [
    "archive",
    ...xcodeTargetArgs(projectInfo),
    "-scheme", scheme,
    "-configuration", configuration,
    "-destination", "generic/platform=iOS",
    "-archivePath", archivePath,
    ...authArgs(auth),
  ];
  const result = await runTool("xcodebuild", args, { timeoutMs: XCODE.ARCHIVE_TIMEOUT_MS });
  if (!result.ok) {
    if (result.timedOut) {
      throw new MobileError(
        `xcodebuild archive timed out after ${XCODE.ARCHIVE_TIMEOUT_MS}ms (scheme "${scheme}")`,
        "XCODE_BUILD_TIMEOUT",
      );
    }
    throw classifyXcodeError(result.stderr, "xcodebuild archive");
  }
}

export async function exportArchive(options: {
  archivePath: string;
  exportOptionsPlist: string;
  exportPath: string;
  auth: AscApiAuth;
}): Promise<{ ipaPath?: string }> {
  const { archivePath, exportOptionsPlist, exportPath, auth } = options;
  validatePath(archivePath, "archive path");
  validatePath(exportOptionsPlist, "export options plist");
  validatePath(exportPath, "export path");
  validateAuth(auth);

  const args = [
    "-exportArchive",
    "-archivePath", archivePath,
    "-exportOptionsPlist", exportOptionsPlist,
    "-exportPath", exportPath,
    ...authArgs(auth),
  ];
  const result = await runTool("xcodebuild", args, { timeoutMs: XCODE.EXPORT_TIMEOUT_MS });
  if (!result.ok) {
    if (result.timedOut) {
      throw new MobileError(
        `xcodebuild -exportArchive timed out after ${XCODE.EXPORT_TIMEOUT_MS}ms`,
        "XCODE_BUILD_TIMEOUT",
      );
    }
    throw classifyXcodeError(result.stderr, "xcodebuild -exportArchive");
  }
  // destination=upload exports straight to ASC — no .ipa on disk is normal.
  return { ipaPath: await findIpa(exportPath) };
}

export async function buildFlutterIpa(projectDir: string): Promise<{ ipaPath: string }> {
  validatePath(projectDir, "flutter project directory");

  const result = await runTool("flutter", ["build", "ipa", "--release"], {
    timeoutMs: XCODE.ARCHIVE_TIMEOUT_MS,
    cwd: projectDir,
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new MobileError(
        `flutter build ipa timed out after ${XCODE.ARCHIVE_TIMEOUT_MS}ms`,
        "XCODE_BUILD_TIMEOUT",
      );
    }
    throw classifyXcodeError(result.stderr, "flutter build ipa");
  }

  const ipaPath = await findIpa(join(projectDir, "build", "ios", "ipa"));
  if (!ipaPath) {
    throw new MobileError(
      "flutter build ipa succeeded but no .ipa was found in build/ios/ipa. " +
        "Check the Flutter build output directory.",
      "FLUTTER_IPA_NOT_FOUND",
    );
  }
  return { ipaPath };
}
