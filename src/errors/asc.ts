import { MobileError } from "./base.js";

/**
 * App Store Connect / TestFlight error classes.
 * Detail strings passed into these constructors MUST already be sanitized
 * (sanitizeErrorMessage + slice) by the caller — see store/app-store-connect.ts.
 */

export class AscKeyMissingError extends MobileError {
  constructor() {
    super(
      "App Store Connect API key is not configured.\n\n" +
        "Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_FILE (path to the .p8 key) environment variables.\n" +
        "Alternatively set ASC_PRIVATE_KEY with the inline PEM content.\n" +
        "Create a key in App Store Connect → Users and Access → Integrations.",
      "ASC_KEY_MISSING"
    );
  }
}

export class AscAuthError extends MobileError {
  constructor(detail: string) {
    super(
      `App Store Connect authentication failed: ${detail}\n\n` +
        "Check ASC_KEY_ID / ASC_ISSUER_ID and that the .p8 key is valid, not revoked, " +
        "and has sufficient role (App Manager or Admin).",
      "ASC_AUTH_ERROR"
    );
  }
}

export class AscUploadError extends MobileError {
  constructor(detail: string) {
    super(`App Store Connect upload failed: ${detail}`, "ASC_UPLOAD_ERROR");
  }
}

export class AscRateLimitError extends MobileError {
  constructor(detail = "") {
    super(
      `App Store Connect rate limit exceeded (HTTP 429).${detail ? ` ${detail}` : ""} ` +
        "Retry after a short delay.",
      "ASC_RATE_LIMIT"
    );
  }
}

export class TestflightVersionCollisionError extends MobileError {
  constructor(version: string) {
    super(
      `TestFlight build with version ${version} already exists.\n\n` +
        "Increment CFBundleVersion (build number) and re-upload.",
      "TESTFLIGHT_VERSION_COLLISION"
    );
  }
}

export class TestflightSigningError extends MobileError {
  constructor(detail: string) {
    super(
      `TestFlight signing failed: ${detail}\n\n` +
        "Check signing identities: security find-identity -v -p codesigning",
      "TESTFLIGHT_SIGNING_ERROR"
    );
  }
}

export class TestflightProcessingFailedError extends MobileError {
  constructor(buildId: string, state: string) {
    super(
      `TestFlight build ${buildId} processing failed (state: ${state}).\n\n` +
        "Check App Store Connect for details — common causes: missing export compliance, " +
        "invalid Info.plist, asset validation failure.",
      "TESTFLIGHT_PROCESSING_FAILED"
    );
  }
}
