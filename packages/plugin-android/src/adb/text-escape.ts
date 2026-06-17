/**
 * Argument and text-escaping helpers used by the ADB client.
 *
 * These helpers are deliberately tiny and stateless so they can be unit-tested
 * independently and reused by helpers that compose adb argv outside of the
 * AdbClient class itself.
 */

/**
 * Split a whitespace-separated command into argv tokens.
 * Safe for commands that do not contain shell-quoted strings.
 * For commands with spaces inside arguments (e.g. text input), build the argv
 * array directly instead of going through this helper.
 */
export function splitArgs(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

/**
 * Escape user text for safe embedding inside a double-quoted `input text "..."` on the
 * device shell. The OUTER context (host shell) never parses this string — it travels as a
 * single argv slot to adb (see AdbClient#inputText / inputTextAsync). Escaping covers only
 * device-side shell metacharacters within double quotes plus Android `input`'s `%s`-for-space
 * quirk.
 */
export function escapeAndroidInputText(text: string): string {
  return text
    .replace(/[\n\r]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/ /g, "%s")
    .replace(/&/g, "\\&")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\|/g, "\\|")
    .replace(/;/g, "\\;");
}
