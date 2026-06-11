/**
 * Validate + upload an .ipa to App Store Connect via `xcrun altool`.
 *
 * Validation gate: `--upload-app` returns "accepted" even for packages Apple
 * later drops server-side (missing launch screen, missing CFBundleIconName,
 * incomplete UISupportedInterfaceOrientations) — the build then NEVER appears
 * in /v1/builds and no error surfaces. `--validate-app` catches those rejects
 * synchronously, so validateIpa runs before uploadIpa.
 *
 * Newer Xcode versions ship `--upload-package`; older ones only understand
 * `--upload-app -f`. We try the modern flag first and fall back exactly once
 * when altool rejects the flag itself (NOT on real upload failures).
 *
 * SECURITY: argv form only (no /bin/sh). The API key is referenced by ID —
 * altool resolves AuthKey_<keyId>.p8 from ~/.appstoreconnect/private/keys/,
 * so no secret material appears in the process list.
 */

import { stat } from "fs/promises";
import { IpaValidationError, MobileError } from "../../errors.js";
import { validatePath } from "../../utils/sanitize.js";
import { XCODE } from "../../constants/timeouts.js";
import { runTool, type ToolResult } from "./exec.js";
import { bundleRejectHint, classifyXcodeError, redactSigningInfo } from "./classify-build-error.js";

const CREDENTIAL_RE = /^[A-Za-z0-9-]+$/;

/** altool's complaints when `--upload-package` predates the installed Xcode. */
const UNKNOWN_FLAG_RE = /unknown flag|unrecognized option|invalid option|unknown option/i;

/** altool validation failures: `      detail : Invalid bundle. Because ...` */
const VALIDATION_DETAIL_RE = /^\s*detail\s*:\s*(.+)$/gm;

/** Cap each extracted `detail :` line and the number of lines reported. */
const MAX_VALIDATION_DETAIL_CHARS = 250;
const MAX_VALIDATION_DETAILS = 5;

interface AltoolCredentials {
  ipaPath: string;
  keyId: string;
  issuerId: string;
}

/** Shared preconditions: path safety, .ipa extension, credential shape, file exists. */
async function assertAltoolPreconditions({ ipaPath, keyId, issuerId }: AltoolCredentials): Promise<void> {
  validatePath(ipaPath, "ipa path");
  if (!ipaPath.endsWith(".ipa")) {
    throw new MobileError(
      `Upload path must point to an .ipa file, got: ${ipaPath}`,
      "INVALID_IPA_PATH",
    );
  }
  if (!CREDENTIAL_RE.test(keyId) || !CREDENTIAL_RE.test(issuerId)) {
    throw new MobileError(
      "Invalid App Store Connect credentials: keyId/issuerId must be alphanumeric (UUID allowed).",
      "INVALID_ASC_CREDENTIALS",
    );
  }
  try {
    if (!(await stat(ipaPath)).isFile()) throw new Error("not a file");
  } catch {
    throw new MobileError(`IPA file not found: ${ipaPath}`, "IPA_NOT_FOUND");
  }
}

function credentialArgs(keyId: string, issuerId: string): string[] {
  return ["-t", "ios", "--apiKey", keyId, "--apiIssuer", issuerId];
}

/**
 * Extract every validation failure (`detail : <text>` line) from REDACTED
 * altool output, appending a recovery hint when the detail matches a known
 * bundle-reject pattern. Deduplicated (altool repeats details across streams).
 */
function extractValidationDetails(output: string): string[] {
  const redacted = redactSigningInfo(output);
  const details: string[] = [];
  const seen = new Set<string>();
  for (const match of redacted.matchAll(VALIDATION_DETAIL_RE)) {
    const detail = match[1].trim().slice(0, MAX_VALIDATION_DETAIL_CHARS);
    if (seen.has(detail)) continue;
    seen.add(detail);
    const hint = bundleRejectHint(detail);
    details.push(hint ? `${detail}\n  Fix: ${hint}` : detail);
    if (details.length >= MAX_VALIDATION_DETAILS) break;
  }
  return details;
}

/**
 * Run `altool --validate-app` against the .ipa and throw IpaValidationError
 * (code IPA_VALIDATION_FAILED) listing every server-side reject reason.
 */
export async function validateIpa(options: AltoolCredentials): Promise<void> {
  const { ipaPath, keyId, issuerId } = options;
  await assertAltoolPreconditions(options);

  const result = await runTool(
    "xcrun",
    ["altool", "--validate-app", "-f", ipaPath, ...credentialArgs(keyId, issuerId)],
    { timeoutMs: XCODE.UPLOAD_TIMEOUT_MS },
  );
  if (result.ok) return;

  if (result.timedOut) {
    throw new MobileError(
      `altool validation timed out after ${XCODE.UPLOAD_TIMEOUT_MS}ms. ` +
        "Retry, or bypass with skipValidation if the package was validated elsewhere.",
      "ASC_VALIDATE_TIMEOUT",
    );
  }

  // Details appear on stdout OR stderr depending on the altool version.
  const details = extractValidationDetails(`${result.stdout}\n${result.stderr}`);
  const fallback =
    redactSigningInfo(result.stderr).trim().slice(-MAX_VALIDATION_DETAIL_CHARS) ||
    "(altool produced no diagnostic output)";
  const body =
    details.length > 0 ? details.map((d, i) => `${i + 1}. ${d}`).join("\n") : fallback;
  throw new IpaValidationError(body);
}

export async function uploadIpa(options: AltoolCredentials): Promise<void> {
  const { ipaPath, keyId, issuerId } = options;
  await assertAltoolPreconditions(options);

  const credentials = credentialArgs(keyId, issuerId);

  let result: ToolResult = await runTool(
    "xcrun",
    ["altool", "--upload-package", ipaPath, ...credentials],
    { timeoutMs: XCODE.UPLOAD_TIMEOUT_MS },
  );

  if (
    !result.ok &&
    !result.timedOut &&
    UNKNOWN_FLAG_RE.test(result.stderr) &&
    result.stderr.includes("--upload-package")
  ) {
    result = await runTool(
      "xcrun",
      ["altool", "--upload-app", "-f", ipaPath, ...credentials],
      { timeoutMs: XCODE.UPLOAD_TIMEOUT_MS },
    );
  }

  if (!result.ok) {
    if (result.timedOut) {
      throw new MobileError(
        `altool upload timed out after ${XCODE.UPLOAD_TIMEOUT_MS}ms. ` +
          "Large IPAs over slow links may need a manual Transporter upload.",
        "ASC_UPLOAD_TIMEOUT",
      );
    }
    throw classifyXcodeError(result.stderr, "altool upload");
  }
}
