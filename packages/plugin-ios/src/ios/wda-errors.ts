/**
 * Pure error-message builders for WDA failures. No I/O.
 */

const INSTALL_HINT =
  "Install: npm install -g appium && appium driver install xcuitest\n" +
  "Or set WDA_PATH environment variable.";

/**
 * Build the standard "WDA required" error message used by tap/swipe/longPress/inputText.
 */
export function wdaRequiredError(operation: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `${operation} requires WebDriverAgent.\n\n${INSTALL_HINT}\n\nError: ${msg}`,
  );
}
