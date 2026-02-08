import { describe, it, expect } from "vitest";
import {
  parseUiHierarchy,
  findByText,
  findByResourceId,
  findByClassName,
  findClickable,
  findElements,
  findBestMatch,
  analyzeScreen,
  formatElement,
  formatUiTree,
  formatScreenAnalysis,
} from "./ui-parser.js";
import type { UiElement } from "./ui-parser.js";

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="Login" resource-id="com.example.app:id/btn_login" class="android.widget.Button" package="com.example.app" content-desc="Login button" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,800][980,900]">
    </node>
    <node index="1" text="" resource-id="com.example.app:id/et_username" class="android.widget.EditText" package="com.example.app" content-desc="Username" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[100,400][980,500]">
    </node>
    <node index="2" text="" resource-id="com.example.app:id/et_password" class="android.widget.EditText" package="com.example.app" content-desc="Password" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[100,550][980,650]">
    </node>
    <node index="3" text="Welcome to App" resource-id="" class="android.widget.TextView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[200,200][880,280]">
    </node>
    <node index="4" text="Sign Up" resource-id="com.example.app:id/btn_signup" class="android.widget.Button" package="com.example.app" content-desc="Create new account" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,950][980,1050]">
    </node>
    <node index="5" text="" resource-id="" class="android.widget.ScrollView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,100][1080,1800]">
    </node>
    <node index="6" text="Forgot password?" resource-id="com.example.app:id/link_forgot" class="android.widget.TextView" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[300,1100][780,1150]">
    </node>
  </node>
</hierarchy>`;

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"></hierarchy>`;

const MALFORMED_XML = `<node text="Hello" bounds="no-bounds-here">`;

// ──────────────────────────────────────────────
// parseUiHierarchy
// ──────────────────────────────────────────────

describe("parseUiHierarchy", () => {
  it("parses valid XML with multiple nodes", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    expect(elements.length).toBe(8); // root + 7 children
  });

  it("extracts bounds correctly", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const loginBtn = elements.find(el => el.text === "Login");
    expect(loginBtn).toBeDefined();
    expect(loginBtn!.bounds).toEqual({ x1: 100, y1: 800, x2: 980, y2: 900 });
  });

  it("calculates center coordinates", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const loginBtn = elements.find(el => el.text === "Login");
    expect(loginBtn!.centerX).toBe(540);
    expect(loginBtn!.centerY).toBe(850);
  });

  it("calculates width and height", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const loginBtn = elements.find(el => el.text === "Login");
    expect(loginBtn!.width).toBe(880);
    expect(loginBtn!.height).toBe(100);
  });

  it("extracts text attributes", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const loginBtn = elements.find(el => el.text === "Login");
    expect(loginBtn!.resourceId).toBe("com.example.app:id/btn_login");
    expect(loginBtn!.className).toBe("android.widget.Button");
    expect(loginBtn!.contentDesc).toBe("Login button");
    expect(loginBtn!.packageName).toBe("com.example.app");
  });

  it("extracts boolean attributes", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const loginBtn = elements.find(el => el.text === "Login");
    expect(loginBtn!.clickable).toBe(true);
    expect(loginBtn!.enabled).toBe(true);
    expect(loginBtn!.focusable).toBe(true);
    expect(loginBtn!.scrollable).toBe(false);
    expect(loginBtn!.password).toBe(false);
  });

  it("detects password fields", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const pwField = elements.find(el => el.contentDesc === "Password");
    expect(pwField!.password).toBe(true);
  });

  it("detects focused elements", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const focused = elements.find(el => el.contentDesc === "Username");
    expect(focused!.focused).toBe(true);
  });

  it("returns empty array for empty XML", () => {
    const elements = parseUiHierarchy(EMPTY_XML);
    expect(elements).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const elements = parseUiHierarchy("");
    expect(elements).toEqual([]);
  });

  it("skips nodes without valid bounds", () => {
    const elements = parseUiHierarchy(MALFORMED_XML);
    expect(elements).toEqual([]);
  });

  it("assigns sequential indices", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    elements.forEach((el, i) => {
      expect(el.index).toBe(i);
    });
  });
});

// ──────────────────────────────────────────────
// findByText
// ──────────────────────────────────────────────

describe("findByText", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("finds by exact text", () => {
    const results = findByText(elements, "Login");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toBe("Login");
  });

  it("finds by partial text (case-insensitive)", () => {
    const results = findByText(elements, "login");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("finds by content description", () => {
    const results = findByText(elements, "Username");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].contentDesc).toBe("Username");
  });

  it("returns empty array when nothing matches", () => {
    const results = findByText(elements, "nonexistent_text_xyz");
    expect(results).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// findByResourceId
// ──────────────────────────────────────────────

describe("findByResourceId", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("finds by full resource ID", () => {
    const results = findByResourceId(elements, "com.example.app:id/btn_login");
    expect(results.length).toBe(1);
  });

  it("finds by partial resource ID", () => {
    const results = findByResourceId(elements, "btn_login");
    expect(results.length).toBe(1);
  });

  it("finds multiple matches", () => {
    const results = findByResourceId(elements, "et_");
    expect(results.length).toBe(2); // et_username and et_password
  });

  it("returns empty when no match", () => {
    const results = findByResourceId(elements, "nonexistent_id");
    expect(results).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// findByClassName
// ──────────────────────────────────────────────

describe("findByClassName", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("finds buttons", () => {
    const results = findByClassName(elements, "Button");
    expect(results.length).toBe(2); // btn_login and btn_signup
  });

  it("finds EditText fields", () => {
    const results = findByClassName(elements, "EditText");
    expect(results.length).toBe(2);
  });

  it("finds by full class name", () => {
    const results = findByClassName(elements, "android.widget.ScrollView");
    expect(results.length).toBe(1);
  });
});

// ──────────────────────────────────────────────
// findClickable
// ──────────────────────────────────────────────

describe("findClickable", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("returns only clickable elements", () => {
    const results = findClickable(elements);
    expect(results.length).toBeGreaterThan(0);
    results.forEach(el => {
      expect(el.clickable).toBe(true);
    });
  });

  it("includes disabled clickable elements", () => {
    const results = findClickable(elements);
    const disabled = results.find(el => !el.enabled);
    expect(disabled).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// findElements (multi-criteria)
// ──────────────────────────────────────────────

describe("findElements", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("filters by text", () => {
    const results = findElements(elements, { text: "Login" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by clickable + enabled", () => {
    const results = findElements(elements, { clickable: true, enabled: true });
    results.forEach(el => {
      expect(el.clickable).toBe(true);
      expect(el.enabled).toBe(true);
    });
  });

  it("filters by className", () => {
    const results = findElements(elements, { className: "EditText" });
    expect(results.length).toBe(2);
  });

  it("filters by visibility", () => {
    const results = findElements(elements, { visible: true });
    results.forEach(el => {
      expect(el.width).toBeGreaterThan(0);
      expect(el.height).toBeGreaterThan(0);
    });
  });

  it("combines multiple criteria", () => {
    const results = findElements(elements, { clickable: true, className: "Button" });
    expect(results.length).toBe(2);
    results.forEach(el => {
      expect(el.clickable).toBe(true);
      expect(el.className).toContain("Button");
    });
  });

  it("returns all elements with empty criteria", () => {
    const results = findElements(elements, {});
    expect(results.length).toBe(elements.length);
  });
});

// ──────────────────────────────────────────────
// findBestMatch
// ──────────────────────────────────────────────

describe("findBestMatch", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("finds exact text match with high confidence", () => {
    const result = findBestMatch(elements, "Login");
    expect(result).not.toBeNull();
    expect(result!.element.text).toBe("Login");
    expect(result!.confidence).toBeGreaterThanOrEqual(90);
  });

  it("finds by content description", () => {
    const result = findBestMatch(elements, "Login button");
    expect(result).not.toBeNull();
    expect(result!.element.contentDesc).toBe("Login button");
  });

  it("finds by resource ID pattern", () => {
    const result = findBestMatch(elements, "btn login");
    expect(result).not.toBeNull();
    expect(result!.element.resourceId).toContain("btn_login");
  });

  it("returns null when nothing matches", () => {
    const result = findBestMatch(elements, "completely_nonexistent_xyz");
    expect(result).toBeNull();
  });

  it("prefers clickable elements", () => {
    const result = findBestMatch(elements, "Sign Up");
    expect(result).not.toBeNull();
    expect(result!.element.clickable).toBe(true);
  });

  it("handles case-insensitive matching", () => {
    const result = findBestMatch(elements, "LOGIN");
    expect(result).not.toBeNull();
    expect(result!.element.text).toBe("Login");
  });

  it("handles partial word matching", () => {
    const result = findBestMatch(elements, "Welcome");
    expect(result).not.toBeNull();
    expect(result!.element.text).toContain("Welcome");
  });

  it("excludes disabled elements", () => {
    // The "Forgot password?" link is disabled
    const result = findBestMatch(elements, "Forgot password?");
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────
// analyzeScreen
// ──────────────────────────────────────────────

describe("analyzeScreen", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("detects buttons", () => {
    const analysis = analyzeScreen(elements);
    expect(analysis.buttons.length).toBeGreaterThan(0);
    const loginBtn = analysis.buttons.find(b => b.label === "Login");
    expect(loginBtn).toBeDefined();
  });

  it("detects input fields (EditText)", () => {
    const analysis = analyzeScreen(elements);
    expect(analysis.inputs.length).toBe(2); // username + password
  });

  it("detects static text", () => {
    const analysis = analyzeScreen(elements);
    const welcome = analysis.texts.find(t => t.content.includes("Welcome"));
    expect(welcome).toBeDefined();
  });

  it("detects scrollable containers", () => {
    const analysis = analyzeScreen(elements);
    expect(analysis.scrollable.length).toBe(1);
  });

  it("generates summary", () => {
    const analysis = analyzeScreen(elements);
    expect(analysis.summary).toContain("buttons");
    expect(analysis.summary).toContain("input field");
  });

  it("includes activity in summary when provided", () => {
    const analysis = analyzeScreen(elements, "com.example.app.LoginActivity");
    expect(analysis.summary).toContain("LoginActivity");
    expect(analysis.activity).toBe("com.example.app.LoginActivity");
  });

  it("returns 'Empty screen' for no elements", () => {
    const analysis = analyzeScreen([]);
    expect(analysis.summary).toBe("Empty screen");
  });

  it("excludes disabled elements from buttons", () => {
    const analysis = analyzeScreen(elements);
    const disabled = analysis.buttons.find(b => b.label.includes("Forgot"));
    expect(disabled).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// formatElement
// ──────────────────────────────────────────────

describe("formatElement", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("includes index and class name", () => {
    const loginBtn = elements.find(el => el.text === "Login")!;
    const formatted = formatElement(loginBtn);
    expect(formatted).toContain(`[${loginBtn.index}]`);
    expect(formatted).toContain("<Button>");
  });

  it("includes text", () => {
    const loginBtn = elements.find(el => el.text === "Login")!;
    const formatted = formatElement(loginBtn);
    expect(formatted).toContain('text="Login"');
  });

  it("includes resource ID (short form)", () => {
    const loginBtn = elements.find(el => el.text === "Login")!;
    const formatted = formatElement(loginBtn);
    expect(formatted).toContain('id="btn_login"');
  });

  it("includes clickable flag", () => {
    const loginBtn = elements.find(el => el.text === "Login")!;
    const formatted = formatElement(loginBtn);
    expect(formatted).toContain("clickable");
  });

  it("includes coordinates", () => {
    const loginBtn = elements.find(el => el.text === "Login")!;
    const formatted = formatElement(loginBtn);
    expect(formatted).toContain("@ (540, 850)");
  });

  it("truncates long text", () => {
    const longTextEl: UiElement = {
      index: 0,
      resourceId: "",
      className: "android.widget.TextView",
      packageName: "com.example",
      text: "A".repeat(100),
      contentDesc: "",
      checkable: false, checked: false, clickable: false, enabled: true,
      focusable: false, focused: false, scrollable: false, longClickable: false,
      password: false, selected: false,
      bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
      centerX: 50, centerY: 25, width: 100, height: 50,
    };
    const formatted = formatElement(longTextEl);
    expect(formatted).toContain("...");
  });
});

// ──────────────────────────────────────────────
// formatUiTree
// ──────────────────────────────────────────────

describe("formatUiTree", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("filters to meaningful elements by default", () => {
    const tree = formatUiTree(elements);
    expect(tree).not.toContain("No UI elements found");
    expect(tree.split("\n").length).toBeGreaterThan(0);
  });

  it("returns all elements with showAll", () => {
    const treeAll = formatUiTree(elements, { showAll: true });
    const treeDefault = formatUiTree(elements);
    expect(treeAll.split("\n").length).toBeGreaterThanOrEqual(treeDefault.split("\n").length);
  });

  it("respects maxElements", () => {
    const tree = formatUiTree(elements, { showAll: true, maxElements: 2 });
    expect(tree.split("\n").length).toBe(2);
  });

  it("returns 'No UI elements found' for empty array", () => {
    const tree = formatUiTree([]);
    expect(tree).toBe("No UI elements found");
  });
});

// ──────────────────────────────────────────────
// formatScreenAnalysis
// ──────────────────────────────────────────────

describe("formatScreenAnalysis", () => {
  const elements = parseUiHierarchy(SAMPLE_XML);

  it("formats analysis with sections", () => {
    const analysis = analyzeScreen(elements, "com.example.LoginActivity");
    const formatted = formatScreenAnalysis(analysis);
    expect(formatted).toContain("=== Screen Analysis ===");
    expect(formatted).toContain("Buttons");
    expect(formatted).toContain("Input fields");
  });

  it("shows empty screen analysis", () => {
    const analysis = analyzeScreen([]);
    const formatted = formatScreenAnalysis(analysis);
    expect(formatted).toContain("Empty screen");
  });
});
