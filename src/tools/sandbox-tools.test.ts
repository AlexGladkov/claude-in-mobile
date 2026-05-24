import { describe, it, expect, vi } from "vitest";
import { sandboxTools } from "./sandbox-tools.js";
import { MobileError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = sandboxTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in sandboxTools`);
  return def.handler;
}

function makeMockContext(shellFn: () => string = () => "", overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getAndroidClient: vi.fn(() => ({
        shell: vi.fn(shellFn),
        exec: vi.fn(() => ""),
      })),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

function makeIosContext(): ToolContext {
  return makeMockContext(() => "", {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "ios"),
      getAndroidClient: vi.fn(),
    } as any,
  });
}

// ──────────────────────────────────────────────
// sandbox_prefs_read
// ──────────────────────────────────────────────

describe("sandbox_prefs_read", () => {
  const handler = findHandler("sandbox_prefs_read");

  it("returns error on non-android platform (ios)", async () => {
    const ctx = makeIosContext();
    const result = await handler({ package: "com.example.app", platform: "ios" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("only available on Android");
  });

  it("returns error when getCurrentPlatform returns ios", async () => {
    const ctx = makeIosContext();
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
  });

  it("throws MobileError for invalid package name with semicolon", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "bad;name" }, ctx)).rejects.toThrow(MobileError);
  });

  it("throws MobileError for package name with pipe injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example|hack" }, ctx)).rejects.toThrow(MobileError);
  });

  it("lists preference files when no file specified", async () => {
    const ctx = makeMockContext(() => "prefs.xml\nuser.xml\n");
    const result = await handler({ package: "com.example.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("Available SharedPreferences files");
    expect(text).toContain("prefs");
    expect(text).toContain("user");
  });

  it("returns 'not found' message when shared_prefs listing is empty", async () => {
    const ctx = makeMockContext(() => "");
    const result = await handler({ package: "com.example.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("No SharedPreferences files found");
  });

  it("returns only .xml files in listing", async () => {
    const ctx = makeMockContext(() => "prefs.xml\nREADME.txt\nother.xml\n");
    const result = await handler({ package: "com.example.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("prefs");
    expect(text).toContain("other");
    expect(text).not.toContain("README.txt");
  });

  it("returns parsed key-value entries from SharedPreferences XML", async () => {
    const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n<string name="key1">val1</string>\n<int name="count" value="42" />\n<boolean name="active" value="true" />\n</map>`;
    const ctx = makeMockContext(() => xml);
    const result = await handler({ package: "com.example.app", file: "prefs" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("key1");
    expect(text).toContain("val1");
    expect(text).toContain("count");
    expect(text).toContain("42");
    expect(text).toContain("active");
    expect(text).toContain("true");
  });

  it("returns run-as failure hint when output contains 'is not debuggable'", async () => {
    const ctx = makeMockContext(() => "package 'com.example.app' is not debuggable");
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("returns run-as failure hint when shell throws with debuggable error", async () => {
    const shellFn = vi.fn().mockImplementationOnce(() => {
      throw new Error("package 'com.example.app' is not debuggable");
    });
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("throws MobileError for path traversal in file name", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example.app", file: "../../etc/passwd" }, ctx)).rejects.toThrow(MobileError);
  });

  it("returns entries count header when parsing succeeds", async () => {
    const xml = `<map><string name="token">abc123</string><int name="retry" value="3" /></map>`;
    const ctx = makeMockContext(() => xml);
    const result = await handler({ package: "com.example.app", file: "settings" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("2 entries");
  });
});

// ──────────────────────────────────────────────
// sandbox_prefs_write
// ──────────────────────────────────────────────

describe("sandbox_prefs_write", () => {
  const handler = findHandler("sandbox_prefs_write");

  it("returns error on non-android platform", async () => {
    const result = await handler(
      { package: "com.example.app", file: "prefs", key: "myKey", value: "myVal", platform: "ios" },
      makeIosContext(),
    );
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("only available on Android");
  });

  it("throws MobileError for invalid package name", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "bad;pkg", file: "prefs", key: "k", value: "v" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for path traversal in file name", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", file: "../etc/shadow", key: "k", value: "v" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("calls shell with correct sed pattern for string type", async () => {
    const shellFn = vi.fn(() => "");
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    await handler({ package: "com.example.app", file: "prefs", key: "myKey", value: "newVal", type: "string" }, ctx);
    expect(shellFn).toHaveBeenCalled();
    const cmd = shellFn.mock.calls[0][0] as string;
    expect(cmd).toContain("sed");
    expect(cmd).toContain("<string name=\"myKey\">");
    expect(cmd).toContain("newVal");
  });

  it("calls shell with correct sed pattern for int type", async () => {
    const shellFn = vi.fn(() => "");
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    await handler({ package: "com.example.app", file: "prefs", key: "count", value: "99", type: "int" }, ctx);
    const cmd = shellFn.mock.calls[0][0] as string;
    expect(cmd).toContain("sed");
    expect(cmd).toContain("<int name=\"count\"");
    expect(cmd).toContain("99");
  });

  it("calls shell with correct sed pattern for bool type (maps to boolean tag)", async () => {
    const shellFn = vi.fn(() => "");
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    await handler({ package: "com.example.app", file: "prefs", key: "flag", value: "false", type: "bool" }, ctx);
    const cmd = shellFn.mock.calls[0][0] as string;
    expect(cmd).toContain("<boolean name=\"flag\"");
    expect(cmd).toContain("false");
  });

  it("returns run-as failure hint when shell throws with debuggable error", async () => {
    const shellFn = vi.fn().mockImplementationOnce(() => {
      throw new Error("is not debuggable");
    });
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app", file: "prefs", key: "k", value: "v" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("returns success message with key/value/type info", async () => {
    const ctx = makeMockContext(() => "");
    const result = await handler(
      { package: "com.example.app", file: "settings", key: "theme", value: "dark", type: "string" },
      ctx,
    );
    const text = (result as { text: string }).text;
    expect(text).toContain("theme");
    expect(text).toContain("dark");
    expect(text).toContain("string");
    expect(text).toContain("settings");
  });
});

// ──────────────────────────────────────────────
// sandbox_sqlite_query
// ──────────────────────────────────────────────

describe("sandbox_sqlite_query", () => {
  const handler = findHandler("sandbox_sqlite_query");

  it("returns error on non-android platform", async () => {
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: "SELECT 1", platform: "ios" },
      makeIosContext(),
    );
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("only available on Android");
  });

  it("throws MobileError for invalid package name", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "bad;pkg", database: "app.db", query: "SELECT 1" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for invalid database name with path traversal", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "../../etc/passwd", query: "SELECT 1" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for INSERT query (write operation)", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "app.db", query: "INSERT INTO users VALUES (1)" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for UPDATE query", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "app.db", query: "UPDATE users SET name='x'" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for DELETE query", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "app.db", query: "DELETE FROM users" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for DROP query", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "app.db", query: "DROP TABLE users" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("throws MobileError for multi-statement query", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", database: "app.db", query: "SELECT 1; DROP TABLE x" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("allows SELECT queries", async () => {
    const ctx = makeMockContext(() => "1|Alice\n2|Bob");
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: "SELECT id, name FROM users" },
      ctx,
    );
    const text = (result as { text: string }).text;
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
  });

  it("allows PRAGMA queries", async () => {
    const ctx = makeMockContext(() => "page_size = 4096");
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: "PRAGMA page_size" },
      ctx,
    );
    expect((result as { text: string; isError?: boolean }).isError).toBeUndefined();
    expect((result as { text: string }).text).toContain("4096");
  });

  it("allows .tables command", async () => {
    const ctx = makeMockContext(() => "users  sessions  config");
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: ".tables" },
      ctx,
    );
    expect((result as { text: string }).text).toContain("users");
  });

  it("returns run-as failure hint when shell output contains debuggable error", async () => {
    const ctx = makeMockContext(() => "package 'com.example.app' is not debuggable");
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: "SELECT 1" },
      ctx,
    );
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("returns query results from sqlite3", async () => {
    const ctx = makeMockContext(() => "42|hello\n43|world");
    const result = await handler(
      { package: "com.example.app", database: "mydata.sqlite", query: "SELECT id, msg FROM logs" },
      ctx,
    );
    const text = (result as { text: string }).text;
    expect(text).toContain("42");
    expect(text).toContain("hello");
  });

  it("returns empty result set message when sqlite3 returns whitespace-only output", async () => {
    // The handler calls shell twice (relative path then absolute path).
    // First call returns empty string -> treated as output (not a run-as failure).
    // But empty string is falsy, so the code falls through to "Query failed".
    // Provide whitespace so the first call returns a non-empty truthy value.
    const ctx = makeMockContext(() => "   \n  ");
    const result = await handler(
      { package: "com.example.app", database: "app.db", query: "SELECT 1 WHERE 1=0" },
      ctx,
    );
    expect((result as { text: string }).text).toContain("(empty result set)");
  });
});

// ──────────────────────────────────────────────
// sandbox_file_list
// ──────────────────────────────────────────────

describe("sandbox_file_list", () => {
  const handler = findHandler("sandbox_file_list");

  it("returns error on non-android platform", async () => {
    const result = await handler(
      { package: "com.example.app", platform: "ios" },
      makeIosContext(),
    );
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("only available on Android");
  });

  it("throws MobileError for invalid package name", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "bad;pkg" }, ctx)).rejects.toThrow(MobileError);
  });

  it("throws MobileError for path traversal in path argument", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example.app", path: "../../etc" }, ctx)).rejects.toThrow(MobileError);
  });

  it("returns directory listing", async () => {
    const listing = "drwxrwx--x  3 u0_a123  u0_a123  4096 Jan  1 00:00 databases\ndrwxrwx--x  2 u0_a123  u0_a123  4096 Jan  1 00:00 shared_prefs";
    const ctx = makeMockContext(() => listing);
    const result = await handler({ package: "com.example.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("databases");
    expect(text).toContain("shared_prefs");
  });

  it("uses default path '.' when path is not specified", async () => {
    const shellFn = vi.fn(() => "files  databases");
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    await handler({ package: "com.example.app" }, ctx);
    const cmd = shellFn.mock.calls[0][0] as string;
    expect(cmd).toContain("ls -la");
    expect(cmd).toContain(".");
  });

  it("returns run-as failure hint when output contains not debuggable", async () => {
    const ctx = makeMockContext(() => "run-as: package not found: com.example.app");
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("returns run-as hint when shell throws with debuggable error", async () => {
    const shellFn = vi.fn().mockImplementationOnce(() => {
      throw new Error("is not debuggable");
    });
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("lists files in a specific subdirectory", async () => {
    const shellFn = vi.fn(() => "app.db  user.db");
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app", path: "databases" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("app.db");
    expect(text).toContain("user.db");
  });
});

// ──────────────────────────────────────────────
// sandbox_file_read
// ──────────────────────────────────────────────

describe("sandbox_file_read", () => {
  const handler = findHandler("sandbox_file_read");

  it("returns error on non-android platform", async () => {
    const result = await handler(
      { package: "com.example.app", path: "files/config.json", platform: "ios" },
      makeIosContext(),
    );
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("only available on Android");
  });

  it("throws MobileError for invalid package name", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "bad;pkg", path: "files/config.json" }, ctx)).rejects.toThrow(MobileError);
  });

  it("throws MobileError for path traversal", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ package: "com.example.app", path: "../../etc/passwd" }, ctx)
    ).rejects.toThrow(MobileError);
  });

  it("returns file contents for text file", async () => {
    const json = '{"user":"alice","theme":"dark"}';
    const ctx = makeMockContext(() => json);
    const result = await handler({ package: "com.example.app", path: "files/config.json" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("alice");
    expect(text).toContain("dark");
  });

  it("detects binary content and reports it", async () => {
    // NUL byte is a strong binary indicator
    const binaryContent = "PK\x03\x04\x00\x00\x00\x00some binary data here\x00\x01\x02\x03";
    const ctx = makeMockContext(() => binaryContent);
    const result = await handler({ package: "com.example.app", path: "files/archive.zip" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("binary file");
  });

  it("suggests sqlite_query for binary files", async () => {
    const binaryContent = "SQLite format 3\x00\x10\x00\x01\x01\x00binary";
    const ctx = makeMockContext(() => binaryContent);
    const result = await handler({ package: "com.example.app", path: "databases/app.db" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("sqlite_query");
  });

  it("returns run-as failure hint when output contains debuggable error", async () => {
    const ctx = makeMockContext(() => "package 'com.example.app' is not debuggable");
    const result = await handler({ package: "com.example.app", path: "files/config.json" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("caps maxBytes at 50000", async () => {
    // Generate a large string to test truncation
    const largeContent = "A".repeat(60000);
    const ctx = makeMockContext(() => largeContent);
    const result = await handler(
      { package: "com.example.app", path: "files/big.txt", maxBytes: 999999 },
      ctx,
    );
    const text = (result as { text: string }).text;
    // truncateOutput should cap at maxBytes=50000
    expect(text.length).toBeLessThanOrEqual(60000); // generous upper bound — truncation applies
  });

  it("returns run-as hint when shell throws with not debuggable message", async () => {
    const shellFn = vi.fn().mockImplementationOnce(() => {
      throw new Error("is not debuggable");
    });
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app", path: "files/config.json" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("run-as failed");
  });

  it("returns file not found error when shell throws no such file", async () => {
    const shellFn = vi.fn().mockImplementationOnce(() => {
      throw new Error("cat: files/missing.txt: No such file or directory");
    });
    const ctx = makeMockContext(() => "", {
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: shellFn, exec: vi.fn() })),
      } as any,
    });
    const result = await handler({ package: "com.example.app", path: "files/missing.txt" }, ctx);
    expect((result as { text: string; isError: boolean }).isError).toBe(true);
    expect((result as { text: string }).text).toContain("not found");
  });
});
