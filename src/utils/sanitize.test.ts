import { describe, it, expect } from "vitest";
import {
  validateShellCommand,
  validateUrl,
  sanitizeForShell,
  validatePackageName,
  validatePermission,
  validatePath,
  sanitizeErrorMessage,
  validateDeviceId,
  validateLogTag,
  validateLogTimestamp,
  validateJvmArg,
  validateBaselineName,
  validatePathContainment,
  validateBundleId,
  validateAscKeyId,
  validateAscIssuerId,
  validateXcodeScheme,
  validateVersionString,
} from "./sanitize.js";
import { MobileError } from "../errors.js";

// ──────────────────────────────────────────────
// validateShellCommand
// ──────────────────────────────────────────────

describe("validateShellCommand", () => {
  it("allows simple safe commands", () => {
    expect(() => validateShellCommand("ls")).not.toThrow();
    expect(() => validateShellCommand("pm list packages")).not.toThrow();
    expect(() => validateShellCommand("am start -n com.example/.MainActivity")).not.toThrow();
    expect(() => validateShellCommand("dumpsys meminfo")).not.toThrow();
    expect(() => validateShellCommand("input tap 100 200")).not.toThrow();
  });

  it("blocks semicolon chaining", () => {
    expect(() => validateShellCommand("ls; rm -rf /")).toThrow(MobileError);
    expect(() => validateShellCommand("echo hello; echo world")).toThrow(MobileError);
  });

  it("blocks pipe operator", () => {
    expect(() => validateShellCommand("ls | grep foo")).toThrow(MobileError);
    expect(() => validateShellCommand("cat file.txt | wc -l")).toThrow(MobileError);
  });

  it("blocks && chaining", () => {
    expect(() => validateShellCommand("cd /tmp && rm file")).toThrow(MobileError);
    expect(() => validateShellCommand("true && false")).toThrow(MobileError);
  });

  it("blocks || chaining", () => {
    expect(() => validateShellCommand("false || echo fallback")).toThrow(MobileError);
  });

  it("blocks backticks", () => {
    expect(() => validateShellCommand("echo `whoami`")).toThrow(MobileError);
    expect(() => validateShellCommand("`id`")).toThrow(MobileError);
  });

  it("blocks output redirect >", () => {
    expect(() => validateShellCommand("echo hack > /etc/passwd")).toThrow(MobileError);
  });

  it("blocks append redirect >>", () => {
    expect(() => validateShellCommand("echo data >> /tmp/log")).toThrow(MobileError);
  });

  it("blocks input redirect <", () => {
    expect(() => validateShellCommand("cat < /etc/shadow")).toThrow(MobileError);
  });

  it("blocks command substitution $()", () => {
    expect(() => validateShellCommand("echo $(whoami)")).toThrow(MobileError);
    expect(() => validateShellCommand("$(id)")).toThrow(MobileError);
  });

  it("blocks sudo", () => {
    expect(() => validateShellCommand("sudo rm -rf /")).toThrow(MobileError);
    expect(() => validateShellCommand("SUDO reboot")).toThrow(MobileError); // case insensitive
  });

  it("blocks rm -rf", () => {
    expect(() => validateShellCommand("rm -rf /")).toThrow(MobileError);
    expect(() => validateShellCommand("RM -RF /data")).toThrow(MobileError); // case insensitive
  });

  it("throws MobileError with SHELL_INJECTION_BLOCKED code", () => {
    try {
      validateShellCommand("ls; rm file");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("SHELL_INJECTION_BLOCKED");
    }
  });

  it("error message describes the restriction", () => {
    try {
      validateShellCommand("echo | cat");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("blocked pattern");
    }
  });

  // LLM-friendly diagnostic messages
  it("error names the offending metacharacter for '&'", () => {
    try {
      validateShellCommand("foo & bar");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const m = (e as MobileError).message;
      expect(m).toContain("'&'");
      expect(m).toContain("system_open_url");
    }
  });

  it("error suggests system_open_url for URL-like '&' usage", () => {
    try {
      validateShellCommand("am start -d https://x.com?a=1&b=2");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("system_open_url");
    }
  });

  it("error names TAB explicitly and mentions copy-paste", () => {
    try {
      validateShellCommand("foo\tbar");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const m = (e as MobileError).message;
      expect(m).toContain("TAB");
      expect(m).toMatch(/copy/i);
    }
  });

  it("error names '${...}' for brace expansion", () => {
    try {
      validateShellCommand("echo ${HOME}");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("${...}");
    }
  });

  it("error names '$(...)' for command substitution", () => {
    try {
      validateShellCommand("echo $(whoami)");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("$(...)");
    }
  });

  it("error suggests ui_tap/ui_swipe as alternatives", () => {
    try {
      validateShellCommand("input tap 1; input tap 2");
      expect.unreachable("Should have thrown");
    } catch (e) {
      const m = (e as MobileError).message;
      expect(m).toMatch(/ui_tap|ui_swipe/);
    }
  });

  // ──────────────────────────────────────────────
  // Regression — issue #40 bypass and adjacent forms
  // ──────────────────────────────────────────────

  it("blocks standalone & (issue #40 host-side RCE bypass)", () => {
    expect(() => validateShellCommand("x & touch /tmp/RCE")).toThrow(MobileError);
    try {
      validateShellCommand("x & touch /tmp/RCE");
    } catch (e) {
      expect((e as MobileError).code).toBe("SHELL_INJECTION_BLOCKED");
    }
  });

  it("blocks brace expansion ${...}", () => {
    expect(() => validateShellCommand("echo ${IFS}cmd")).toThrow(MobileError);
    expect(() => validateShellCommand("${PATH:0:1}")).toThrow(MobileError);
  });

  it("blocks process substitution <(...)", () => {
    expect(() => validateShellCommand("diff <(echo a) <(echo b)")).toThrow(MobileError);
    expect(() => validateShellCommand("cat <(whoami)")).toThrow(MobileError);
  });

  it("blocks process substitution >(...)", () => {
    expect(() => validateShellCommand("tee >(cat) <(echo)")).toThrow(MobileError);
  });

  it("blocks tab character injection", () => {
    expect(() => validateShellCommand("cmd\trest")).toThrow(MobileError);
  });

  it("blocks combinations of bypass primitives", () => {
    expect(() => validateShellCommand("x & ${HOME}/run")).toThrow(MobileError);
    expect(() => validateShellCommand("x\t& y")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateUrl
// ──────────────────────────────────────────────

describe("validateUrl", () => {
  it("allows http URLs and returns URL object", () => {
    const result = validateUrl("http://example.com");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("http:");
    expect(result.hostname).toBe("example.com");
  });

  it("allows https URLs", () => {
    const result = validateUrl("https://example.com/path?q=1");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("https:");
  });

  it("allows market URLs", () => {
    const result = validateUrl("market://details?id=com.example.app");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("market:");
  });

  it("allows tel URLs", () => {
    const result = validateUrl("tel:+1234567890");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("tel:");
  });

  it("allows mailto URLs", () => {
    const result = validateUrl("mailto:user@example.com");
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe("mailto:");
  });

  it("throws INVALID_URL for malformed URLs", () => {
    try {
      validateUrl("not a url");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("INVALID_URL");
    }
  });

  it("throws INVALID_URL for empty string", () => {
    try {
      validateUrl("");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("INVALID_URL");
    }
  });

  it("throws URL_SCHEME_BLOCKED for javascript: scheme", () => {
    try {
      validateUrl("javascript:alert(1)");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("URL_SCHEME_BLOCKED");
    }
  });

  it("throws URL_SCHEME_BLOCKED for file: scheme", () => {
    try {
      validateUrl("file:///etc/passwd");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("URL_SCHEME_BLOCKED");
    }
  });

  it("throws URL_SCHEME_BLOCKED for ftp: scheme", () => {
    try {
      validateUrl("ftp://files.example.com/secret");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("URL_SCHEME_BLOCKED");
    }
  });

  it("error message includes the blocked protocol", () => {
    try {
      validateUrl("ftp://example.com");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("ftp:");
    }
  });
});

// ──────────────────────────────────────────────
// sanitizeForShell
// ──────────────────────────────────────────────

describe("sanitizeForShell", () => {
  it("returns clean strings unchanged", () => {
    expect(sanitizeForShell("hello world")).toBe("hello world");
    expect(sanitizeForShell("com.example.app")).toBe("com.example.app");
    expect(sanitizeForShell("simple-text_123")).toBe("simple-text_123");
  });

  it("removes backticks", () => {
    expect(sanitizeForShell("echo `whoami`")).toBe("echo whoami");
  });

  it("removes dollar signs", () => {
    expect(sanitizeForShell("$HOME")).toBe("HOME");
    expect(sanitizeForShell("$(command)")).toBe("command"); // both $ and () are stripped
  });

  it("removes backslashes", () => {
    expect(sanitizeForShell("path\\to\\file")).toBe("pathtofile");
  });

  it("removes exclamation marks", () => {
    expect(sanitizeForShell("hello!")).toBe("hello");
  });

  it("removes hash symbols", () => {
    expect(sanitizeForShell("#comment")).toBe("comment");
  });

  it("removes ampersands", () => {
    expect(sanitizeForShell("cmd1 & cmd2")).toBe("cmd1  cmd2");
  });

  it("removes pipe characters", () => {
    expect(sanitizeForShell("cmd1 | cmd2")).toBe("cmd1  cmd2");
  });

  it("removes semicolons", () => {
    expect(sanitizeForShell("cmd1; cmd2")).toBe("cmd1 cmd2");
  });

  it("removes parentheses", () => {
    expect(sanitizeForShell("$(subshell)")).toBe("subshell");
  });

  it("removes curly braces", () => {
    expect(sanitizeForShell("{expansion}")).toBe("expansion");
  });

  it("removes angle brackets", () => {
    expect(sanitizeForShell("redirect > file < input")).toBe("redirect  file  input");
  });

  it("removes multiple dangerous chars at once", () => {
    expect(sanitizeForShell("`$\\!#&|;(){}<>")).toBe("");
  });

  it("preserves non-dangerous special chars", () => {
    expect(sanitizeForShell("file.txt")).toBe("file.txt");
    expect(sanitizeForShell("path/to/dir")).toBe("path/to/dir");
    expect(sanitizeForShell("key=value")).toBe("key=value");
    expect(sanitizeForShell("name@host")).toBe("name@host");
  });
});

// ──────────────────────────────────────────────
// validatePackageName
// ──────────────────────────────────────────────

describe("validatePackageName", () => {
  it("accepts valid package names", () => {
    expect(() => validatePackageName("com.example.app")).not.toThrow();
    expect(() => validatePackageName("com.android.settings")).not.toThrow();
    expect(() => validatePackageName("org.test.MyApp123")).not.toThrow();
    expect(() => validatePackageName("a")).not.toThrow();
    expect(() => validatePackageName("App")).not.toThrow();
  });

  it("accepts names with underscores", () => {
    expect(() => validatePackageName("com.my_app.test")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validatePackageName("")).toThrow(MobileError);
  });

  it("rejects names starting with a number", () => {
    expect(() => validatePackageName("1com.example")).toThrow(MobileError);
  });

  it("rejects names with spaces", () => {
    expect(() => validatePackageName("com.example app")).toThrow(MobileError);
  });

  it("rejects names with shell special chars", () => {
    expect(() => validatePackageName("com.example;rm")).toThrow(MobileError);
    expect(() => validatePackageName("com.example|cat")).toThrow(MobileError);
    expect(() => validatePackageName("com.example&")).toThrow(MobileError);
  });

  it("rejects names with dashes", () => {
    expect(() => validatePackageName("com.my-app")).toThrow(MobileError);
  });

  it("throws with INVALID_PACKAGE_NAME code", () => {
    try {
      validatePackageName("");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });

  it("error message includes the invalid name", () => {
    try {
      validatePackageName("bad name!");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("bad name!");
    }
  });
});

// ──────────────────────────────────────────────
// validatePermission
// ──────────────────────────────────────────────

describe("validatePermission", () => {
  it("accepts valid Android permissions", () => {
    expect(() => validatePermission("android.permission.CAMERA")).not.toThrow();
    expect(() => validatePermission("android.permission.READ_EXTERNAL_STORAGE")).not.toThrow();
    expect(() => validatePermission("android.permission.INTERNET")).not.toThrow();
  });

  it("accepts custom permission formats", () => {
    expect(() => validatePermission("com.example.permission.CUSTOM")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validatePermission("")).toThrow(MobileError);
  });

  it("rejects permissions starting with a number", () => {
    expect(() => validatePermission("123.permission")).toThrow(MobileError);
  });

  it("rejects permissions with spaces", () => {
    expect(() => validatePermission("android.permission .CAMERA")).toThrow(MobileError);
  });

  it("rejects permissions with shell special chars", () => {
    expect(() => validatePermission("android;drop")).toThrow(MobileError);
    expect(() => validatePermission("perm|hack")).toThrow(MobileError);
  });

  it("throws with INVALID_PERMISSION code", () => {
    try {
      validatePermission("");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("INVALID_PERMISSION");
    }
  });

  it("error message includes the invalid permission", () => {
    try {
      validatePermission("bad perm!");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("bad perm!");
    }
  });
});

// ──────────────────────────────────────────────
// validatePath
// ──────────────────────────────────────────────

describe("validatePath", () => {
  it("allows clean absolute paths", () => {
    expect(() => validatePath("/sdcard/screenshot.png", "screenshot")).not.toThrow();
    expect(() => validatePath("/data/local/tmp/file.txt", "file")).not.toThrow();
  });

  it("allows clean relative paths", () => {
    expect(() => validatePath("screenshots/image.png", "image")).not.toThrow();
    expect(() => validatePath("folder/subfolder/file", "file")).not.toThrow();
  });

  it("allows single dots in filenames", () => {
    expect(() => validatePath("/sdcard/file.name.txt", "file")).not.toThrow();
    expect(() => validatePath("./current", "current")).not.toThrow();
  });

  it("blocks path traversal with ..", () => {
    expect(() => validatePath("../etc/passwd", "path")).toThrow(MobileError);
    expect(() => validatePath("/sdcard/../etc/shadow", "path")).toThrow(MobileError);
    expect(() => validatePath("folder/../../root", "path")).toThrow(MobileError);
  });

  it("blocks .. at any position", () => {
    expect(() => validatePath("..hidden", "label")).toThrow(MobileError);
    expect(() => validatePath("dir/..file", "label")).toThrow(MobileError);
    expect(() => validatePath("a..", "label")).toThrow(MobileError);
  });

  it("throws with PATH_TRAVERSAL_BLOCKED code", () => {
    try {
      validatePath("../../etc/passwd", "test");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("PATH_TRAVERSAL_BLOCKED");
    }
  });

  it("error message includes the label", () => {
    try {
      validatePath("../hack", "screenshot_path");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("screenshot_path");
    }
  });

  it("error message mentions path traversal", () => {
    try {
      validatePath("../hack", "label");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("Path traversal blocked");
    }
  });
});

// ──────────────────────────────────────────────
// sanitizeErrorMessage
// ──────────────────────────────────────────────

describe("sanitizeErrorMessage", () => {
  it("returns clean messages unchanged", () => {
    expect(sanitizeErrorMessage("Something failed with status 404")).toBe("Something failed with status 404");
  });

  it("redacts Bearer tokens", () => {
    const msg = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    expect(sanitizeErrorMessage(msg)).toBe("Authorization: Bearer [REDACTED]");
    expect(sanitizeErrorMessage(msg)).not.toContain("eyJhbGci");
  });

  it("redacts token= values (case-insensitive)", () => {
    expect(sanitizeErrorMessage("token=abc123def")).toBe("token=[REDACTED]");
    const result = sanitizeErrorMessage("Token: xyz789");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("xyz789");
  });

  it("redacts key= values (case-insensitive)", () => {
    expect(sanitizeErrorMessage("key=mySecretKey123")).toBe("key=[REDACTED]");
    const result = sanitizeErrorMessage("apiKey: AKIA1234567890");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIA1234567890");
  });

  it("handles multiple sensitive patterns in one message", () => {
    const msg = "Failed: Bearer secret123, token=abc, key=xyz";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("secret123");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("xyz");
    expect(result).toContain("[REDACTED]");
  });

  it("preserves non-sensitive parts of the message", () => {
    const msg = "Google Play API 403 POST https://example.com: Bearer tokenValue";
    const result = sanitizeErrorMessage(msg);
    expect(result).toContain("Google Play API 403 POST https://example.com:");
    expect(result).not.toContain("tokenValue");
  });
});

// ──────────────────────────────────────────────
// Shell command blocklist — dangerous commands
// ──────────────────────────────────────────────

describe("validateShellCommand blocklist", () => {
  it("blocks curl", () => {
    expect(() => validateShellCommand("curl http://evil.com")).toThrow(MobileError);
    try {
      validateShellCommand("curl http://evil.com");
    } catch (e) {
      expect((e as MobileError).code).toBe("SHELL_INJECTION_BLOCKED");
    }
  });

  it("blocks wget", () => {
    expect(() => validateShellCommand("wget http://evil.com")).toThrow(MobileError);
  });

  it("blocks nc (netcat)", () => {
    expect(() => validateShellCommand("nc -l 4444")).toThrow(MobileError);
  });

  it("blocks dd", () => {
    expect(() => validateShellCommand("dd if=/dev/zero of=/dev/sda")).toThrow(MobileError);
  });

  it("blocks newline injection", () => {
    expect(() => validateShellCommand("command\nmalicious")).toThrow(MobileError);
    try {
      validateShellCommand("command\nmalicious");
    } catch (e) {
      expect((e as MobileError).code).toBe("SHELL_INJECTION_BLOCKED");
    }
  });

  it("blocks carriage return injection", () => {
    expect(() => validateShellCommand("command\rmalicious")).toThrow(MobileError);
    try {
      validateShellCommand("command\rmalicious");
    } catch (e) {
      expect((e as MobileError).code).toBe("SHELL_INJECTION_BLOCKED");
    }
  });
});

// ──────────────────────────────────────────────
// validateDeviceId
// ──────────────────────────────────────────────

describe("validateDeviceId", () => {
  it("accepts emulator ID", () => {
    expect(() => validateDeviceId("emulator-5554")).not.toThrow();
  });

  it("accepts IP:port format", () => {
    expect(() => validateDeviceId("192.168.1.1:5555")).not.toThrow();
  });

  it("accepts serial number HT4C1JS00123", () => {
    expect(() => validateDeviceId("HT4C1JS00123")).not.toThrow();
  });

  it("accepts serial number R5CR20BDJHK", () => {
    expect(() => validateDeviceId("R5CR20BDJHK")).not.toThrow();
  });

  it("rejects device ID with semicolon injection", () => {
    expect(() => validateDeviceId("device;rm")).toThrow(MobileError);
    try {
      validateDeviceId("device;rm");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_DEVICE_ID");
    }
  });

  it("rejects device ID with $() command substitution", () => {
    expect(() => validateDeviceId("device$(cmd)")).toThrow(MobileError);
  });

  it("rejects device ID with pipe", () => {
    expect(() => validateDeviceId("device|pipe")).toThrow(MobileError);
  });

  it("rejects empty string", () => {
    expect(() => validateDeviceId("")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateLogTag
// ──────────────────────────────────────────────

describe("validateLogTag", () => {
  it("accepts ActivityManager", () => {
    expect(() => validateLogTag("ActivityManager")).not.toThrow();
  });

  it("accepts System.err", () => {
    expect(() => validateLogTag("System.err")).not.toThrow();
  });

  it("accepts my-tag", () => {
    expect(() => validateLogTag("my-tag")).not.toThrow();
  });

  it("accepts wildcard *", () => {
    expect(() => validateLogTag("*")).not.toThrow();
  });

  it("rejects tag with semicolon injection", () => {
    expect(() => validateLogTag("tag;rm")).toThrow(MobileError);
    try {
      validateLogTag("tag;rm");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_LOG_TAG");
    }
  });

  it("rejects tag with pipe", () => {
    expect(() => validateLogTag("tag|pipe")).toThrow(MobileError);
  });

  it("rejects tag with $() command substitution", () => {
    expect(() => validateLogTag("tag$(cmd)")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateLogTimestamp
// ──────────────────────────────────────────────

describe("validateLogTimestamp", () => {
  it("accepts logcat format 01-01 12:00:00.000", () => {
    expect(() => validateLogTimestamp("01-01 12:00:00.000")).not.toThrow();
  });

  it("accepts date format 2026-04-23", () => {
    expect(() => validateLogTimestamp("2026-04-23")).not.toThrow();
  });

  it("rejects timestamp with semicolon injection", () => {
    expect(() => validateLogTimestamp("2026;rm -rf")).toThrow(MobileError);
    try {
      validateLogTimestamp("2026;rm -rf");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_LOG_TIMESTAMP");
    }
  });

  it("rejects timestamp with $() command substitution", () => {
    expect(() => validateLogTimestamp("date$(cmd)")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateJvmArg
// ──────────────────────────────────────────────

describe("validateJvmArg", () => {
  it("accepts -Xmx512m", () => {
    expect(() => validateJvmArg("-Xmx512m")).not.toThrow();
  });

  it("accepts -Dfoo=bar", () => {
    expect(() => validateJvmArg("-Dfoo=bar")).not.toThrow();
  });

  it("accepts -ea", () => {
    expect(() => validateJvmArg("-ea")).not.toThrow();
  });

  it("rejects arg with semicolon injection", () => {
    expect(() => validateJvmArg("-javaagent:evil.jar;rm")).toThrow(MobileError);
    try {
      validateJvmArg("-javaagent:evil.jar;rm");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_JVM_ARG");
    }
  });

  it("rejects arg with && chaining", () => {
    expect(() => validateJvmArg("arg&&cmd")).toThrow(MobileError);
  });

  it("rejects arg with $() command substitution", () => {
    expect(() => validateJvmArg("arg$(cmd)")).toThrow(MobileError);
  });

  it("rejects arg with pipe", () => {
    expect(() => validateJvmArg("arg|cmd")).toThrow(MobileError);
  });

  it("rejects arg with newline", () => {
    expect(() => validateJvmArg("arg\ncmd")).toThrow(MobileError);
  });

  it("rejects arg with backtick", () => {
    expect(() => validateJvmArg("arg`cmd`")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateBaselineName
// ──────────────────────────────────────────────

describe("validateBaselineName", () => {
  it("accepts valid baseline names", () => {
    expect(() => validateBaselineName("login-screen")).not.toThrow();
    expect(() => validateBaselineName("dashboard")).not.toThrow();
    expect(() => validateBaselineName("home_v2")).not.toThrow();
    expect(() => validateBaselineName("Screen.main")).not.toThrow();
    expect(() => validateBaselineName("a")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateBaselineName("")).toThrow(MobileError);
    try {
      validateBaselineName("");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_BASELINE_NAME");
    }
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateBaselineName("   ")).toThrow(MobileError);
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateBaselineName("../evil")).toThrow(MobileError);
    expect(() => validateBaselineName("a/b")).toThrow(MobileError);
    expect(() => validateBaselineName("..")).toThrow(MobileError);
  });

  it("rejects names starting with non-alphanumeric", () => {
    expect(() => validateBaselineName("-start")).toThrow(MobileError);
    expect(() => validateBaselineName("_start")).toThrow(MobileError);
    expect(() => validateBaselineName(".start")).toThrow(MobileError);
  });

  it("rejects names with special characters", () => {
    expect(() => validateBaselineName("name with spaces")).toThrow(MobileError);
    expect(() => validateBaselineName("name;injection")).toThrow(MobileError);
    expect(() => validateBaselineName("name|pipe")).toThrow(MobileError);
  });

  it("rejects Windows reserved names", () => {
    expect(() => validateBaselineName("CON")).toThrow(MobileError);
    expect(() => validateBaselineName("PRN")).toThrow(MobileError);
    expect(() => validateBaselineName("NUL")).toThrow(MobileError);
    expect(() => validateBaselineName("COM1")).toThrow(MobileError);
    expect(() => validateBaselineName("LPT1")).toThrow(MobileError);
    // Case insensitive
    expect(() => validateBaselineName("con")).toThrow(MobileError);
    expect(() => validateBaselineName("Con.txt")).toThrow(MobileError);
  });

  it("uses custom label in error message", () => {
    try {
      validateBaselineName("", "platform");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).message).toContain("platform");
    }
  });

  it("rejects names longer than 128 chars", () => {
    const longName = "a" + "b".repeat(128);
    expect(() => validateBaselineName(longName)).toThrow(MobileError);
  });

  it("accepts name exactly 128 chars", () => {
    const name = "a" + "b".repeat(127);
    expect(() => validateBaselineName(name)).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// validatePathContainment
// ──────────────────────────────────────────────

describe("validatePathContainment", () => {
  it("allows paths within base directory", () => {
    expect(() => validatePathContainment("/base/dir/file.png", "/base/dir")).not.toThrow();
    expect(() => validatePathContainment("/base/dir/sub/file.png", "/base/dir")).not.toThrow();
  });

  it("allows path equal to base directory", () => {
    expect(() => validatePathContainment("/base/dir", "/base/dir")).not.toThrow();
  });

  it("blocks path escape via ..", () => {
    expect(() => validatePathContainment("/base/dir/../etc/passwd", "/base/dir")).toThrow(MobileError);
    try {
      validatePathContainment("/base/dir/../etc/passwd", "/base/dir");
    } catch (e) {
      expect((e as MobileError).code).toBe("PATH_CONTAINMENT_VIOLATION");
    }
  });

  it("blocks completely different paths", () => {
    expect(() => validatePathContainment("/other/path/file.png", "/base/dir")).toThrow(MobileError);
  });

  it("blocks path that is prefix but not child", () => {
    // /base/directory is NOT inside /base/dir (just shares prefix)
    expect(() => validatePathContainment("/base/directory/file.png", "/base/dir")).toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// validateBundleId
// ──────────────────────────────────────────────

describe("validateBundleId", () => {
  it("accepts valid bundle IDs", () => {
    expect(() => validateBundleId("com.apple.TextEdit")).not.toThrow();
    expect(() => validateBundleId("com.example.my-app")).not.toThrow();
    expect(() => validateBundleId("org.mozilla.firefox")).not.toThrow();
    expect(() => validateBundleId("a.b")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateBundleId("")).toThrow(MobileError);
  });

  it("rejects bundle ID starting with a number", () => {
    expect(() => validateBundleId("123.invalid")).toThrow(MobileError);
  });

  it("rejects bundle ID with shell injection", () => {
    expect(() => validateBundleId("com.app; rm -rf /")).toThrow(MobileError);
  });

  it("rejects bundle ID with newline injection", () => {
    expect(() => validateBundleId("com.app\nmalicious")).toThrow(MobileError);
  });

  it("rejects bundle ID starting with a dot", () => {
    expect(() => validateBundleId(".starts.with.dot")).toThrow(MobileError);
  });

  it("throws with INVALID_BUNDLE_ID code", () => {
    try {
      validateBundleId("");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("INVALID_BUNDLE_ID");
    }
  });
});

// ──────────────────────────────────────────────
// validateAscKeyId
// ──────────────────────────────────────────────

describe("validateAscKeyId", () => {
  it("accepts a 10-char uppercase alphanumeric key ID", () => {
    expect(() => validateAscKeyId("2X9R4HXF34")).not.toThrow();
    expect(() => validateAscKeyId("ABC123DEFG")).not.toThrow();
    expect(() => validateAscKeyId("0000000000")).not.toThrow();
  });

  it("rejects wrong lengths", () => {
    expect(() => validateAscKeyId("")).toThrow(MobileError);
    expect(() => validateAscKeyId("ABC123DEF")).toThrow(MobileError); // 9 chars
    expect(() => validateAscKeyId("ABC123DEFGH")).toThrow(MobileError); // 11 chars
  });

  it("rejects lowercase and special characters", () => {
    expect(() => validateAscKeyId("abc123defg")).toThrow(MobileError);
    expect(() => validateAscKeyId("ABC123DEF;")).toThrow(MobileError);
    expect(() => validateAscKeyId("ABC 123DEF")).toThrow(MobileError);
  });

  it("throws with INVALID_ASC_KEY_ID code", () => {
    try {
      validateAscKeyId("bad");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_ASC_KEY_ID");
    }
  });
});

// ──────────────────────────────────────────────
// validateAscIssuerId
// ──────────────────────────────────────────────

describe("validateAscIssuerId", () => {
  it("accepts UUID format (any case)", () => {
    expect(() => validateAscIssuerId("69a6de70-03db-47e3-e053-5b8c7c11a4d1")).not.toThrow();
    expect(() => validateAscIssuerId("69A6DE70-03DB-47E3-E053-5B8C7C11A4D1")).not.toThrow();
  });

  it("rejects non-UUID strings", () => {
    expect(() => validateAscIssuerId("")).toThrow(MobileError);
    expect(() => validateAscIssuerId("not-a-uuid")).toThrow(MobileError);
    expect(() => validateAscIssuerId("69a6de70-03db-47e3-e053")).toThrow(MobileError);
    expect(() => validateAscIssuerId("69a6de70-03db-47e3-e053-5b8c7c11a4d1; rm -rf /")).toThrow(MobileError);
    expect(() => validateAscIssuerId("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toThrow(MobileError);
  });

  it("throws with INVALID_ASC_ISSUER_ID code", () => {
    try {
      validateAscIssuerId("bad");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_ASC_ISSUER_ID");
    }
  });
});

// ──────────────────────────────────────────────
// validateXcodeScheme
// ──────────────────────────────────────────────

describe("validateXcodeScheme", () => {
  it("accepts typical scheme names", () => {
    expect(() => validateXcodeScheme("MyApp")).not.toThrow();
    expect(() => validateXcodeScheme("My App iOS")).not.toThrow();
    expect(() => validateXcodeScheme("App-Staging_v2.1")).not.toThrow();
  });

  it("rejects empty and over-long names", () => {
    expect(() => validateXcodeScheme("")).toThrow(MobileError);
    expect(() => validateXcodeScheme("a".repeat(129))).toThrow(MobileError);
  });

  it("rejects shell metacharacters", () => {
    expect(() => validateXcodeScheme("App; rm -rf /")).toThrow(MobileError);
    expect(() => validateXcodeScheme("App$(whoami)")).toThrow(MobileError);
    expect(() => validateXcodeScheme("App\nMalicious")).toThrow(MobileError);
  });

  it("throws with INVALID_XCODE_SCHEME code", () => {
    try {
      validateXcodeScheme("");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_XCODE_SCHEME");
    }
  });
});

// ──────────────────────────────────────────────
// validateVersionString
// ──────────────────────────────────────────────

describe("validateVersionString", () => {
  it("accepts 1-3 numeric components", () => {
    expect(() => validateVersionString("1")).not.toThrow();
    expect(() => validateVersionString("1.2")).not.toThrow();
    expect(() => validateVersionString("1.2.3")).not.toThrow();
    expect(() => validateVersionString("10.20.30")).not.toThrow();
  });

  it("rejects malformed versions", () => {
    expect(() => validateVersionString("")).toThrow(MobileError);
    expect(() => validateVersionString("1.2.3.4")).toThrow(MobileError);
    expect(() => validateVersionString("v1.2")).toThrow(MobileError);
    expect(() => validateVersionString("1..2")).toThrow(MobileError);
    expect(() => validateVersionString("1.2-beta")).toThrow(MobileError);
    expect(() => validateVersionString("1.2;")).toThrow(MobileError);
  });

  it("throws with INVALID_VERSION_STRING code", () => {
    try {
      validateVersionString("bad");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_VERSION_STRING");
    }
  });
});

// ──────────────────────────────────────────────
// sanitizeErrorMessage — JWT redaction
// ──────────────────────────────────────────────

describe("sanitizeErrorMessage JWT redaction", () => {
  const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJzZWNyZXQifQ.c2lnbmF0dXJl";

  it("redacts standalone JWTs (no Bearer prefix)", () => {
    const out = sanitizeErrorMessage(`request failed with ${JWT} attached`);
    expect(out).not.toContain("eyJ");
    expect(out).toContain("[REDACTED_JWT]");
  });

  it("redacts JWTs embedded in JSON error bodies", () => {
    const out = sanitizeErrorMessage(`{"errors":[{"detail":"jwt ${JWT} expired"}]}`);
    expect(out).not.toContain(JWT);
  });

  it("still redacts Bearer-prefixed JWTs via the Bearer rule", () => {
    const out = sanitizeErrorMessage(`Authorization: Bearer ${JWT}`);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain("eyJ");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeErrorMessage("plain error, nothing secret")).toBe("plain error, nothing secret");
  });
});
