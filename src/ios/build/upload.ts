/**
 * Upload an .ipa to App Store Connect via `xcrun altool`.
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
import { MobileError } from "../../errors.js";
import { validatePath } from "../../utils/sanitize.js";
import { XCODE } from "../../constants/timeouts.js";
import { runTool, type ToolResult } from "./exec.js";
import { classifyXcodeError } from "./classify-build-error.js";

const CREDENTIAL_RE = /^[A-Za-z0-9-]+$/;

/** altool's complaints when `--upload-package` predates the installed Xcode. */
const UNKNOWN_FLAG_RE = /unknown flag|unrecognized option|invalid option|unknown option/i;

export async function uploadIpa(options: {
  ipaPath: string;
  keyId: string;
  issuerId: string;
}): Promise<void> {
  const { ipaPath, keyId, issuerId } = options;

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

  const credentials = ["-t", "ios", "--apiKey", keyId, "--apiIssuer", issuerId];

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
