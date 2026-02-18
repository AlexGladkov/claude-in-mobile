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
  detectScreenTitle,
  detectDialog,
  detectNavigation,
  desktopHierarchyToUiElements,
  diffUiElements,
  suggestNextActions,
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

// ──────────────────────────────────────────────
// Feature 2: detectScreenTitle
// ──────────────────────────────────────────────

describe("detectScreenTitle", () => {
  it("detects title from Toolbar element", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "android.widget.Toolbar", text: "Settings" }),
    ];
    expect(detectScreenTitle(elements)).toBe("Settings");
  });

  it("falls back to top-of-screen text", () => {
    const elements: UiElement[] = [
      makeTestElement({
        className: "android.widget.TextView", text: "Profile",
        bounds: { x1: 50, y1: 80, x2: 500, y2: 120 },
      }),
    ];
    expect(detectScreenTitle(elements)).toBe("Profile");
  });

  it("returns undefined when no title found", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "android.widget.Button", text: "Click me", clickable: true }),
    ];
    expect(detectScreenTitle(elements)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// Feature 2: detectDialog
// ──────────────────────────────────────────────

describe("detectDialog", () => {
  it("detects AlertDialog", () => {
    const elements: UiElement[] = [
      makeTestElement({
        className: "android.app.AlertDialog",
        bounds: { x1: 100, y1: 300, x2: 900, y2: 700 },
      }),
      makeTestElement({
        className: "android.widget.TextView", text: "Delete item?",
        bounds: { x1: 120, y1: 320, x2: 880, y2: 380 },
      }),
    ];
    const result = detectDialog(elements);
    expect(result.hasDialog).toBe(true);
    expect(result.dialogTitle).toBe("Delete item?");
  });

  it("returns false when no dialog", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const result = detectDialog(elements);
    expect(result.hasDialog).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Feature 2: detectNavigation
// ──────────────────────────────────────────────

describe("detectNavigation", () => {
  it("detects back button", () => {
    const elements: UiElement[] = [
      makeTestElement({ contentDesc: "Navigate up", clickable: true }),
    ];
    const result = detectNavigation(elements);
    expect(result.hasBack).toBe(true);
  });

  it("detects menu button", () => {
    const elements: UiElement[] = [
      makeTestElement({ contentDesc: "More options", clickable: true }),
    ];
    const result = detectNavigation(elements);
    expect(result.hasMenu).toBe(true);
  });

  it("detects tab layout", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "com.google.android.material.tabs.TabLayout" }),
      makeTestElement({ className: "TabItem", text: "Home", selected: true }),
    ];
    const result = detectNavigation(elements);
    expect(result.hasTabs).toBe(true);
    expect(result.currentTab).toBe("Home");
  });

  it("returns all false for plain screen", () => {
    const result = detectNavigation([]);
    expect(result.hasBack).toBe(false);
    expect(result.hasMenu).toBe(false);
    expect(result.hasTabs).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Feature 2: desktopHierarchyToUiElements
// ──────────────────────────────────────────────

describe("desktopHierarchyToUiElements", () => {
  it("parses desktop hierarchy text", () => {
    const text = `<Button> text="OK" @ (100, 200) [80x30]\n<TextField> text="Search" @ (50, 50) [200x30]`;
    const elements = desktopHierarchyToUiElements(text);
    expect(elements.length).toBe(2);
    expect(elements[0].className).toBe("Button");
    expect(elements[0].text).toBe("OK");
    expect(elements[0].clickable).toBe(true);
    expect(elements[1].className).toBe("TextField");
  });

  it("handles empty input", () => {
    const elements = desktopHierarchyToUiElements("");
    expect(elements).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// Feature 2: analyzeScreen cross-platform
// ──────────────────────────────────────────────

describe("analyzeScreen cross-platform", () => {
  it("detects iOS TextField as input", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "XCUIElementTypeTextField", text: "" , contentDesc: "Email" }),
    ];
    const analysis = analyzeScreen(elements);
    expect(analysis.inputs.length).toBe(1);
    expect(analysis.inputs[0].hint).toBe("Email");
  });

  it("detects iOS StaticText as text", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "XCUIElementTypeStaticText", text: "Hello World" }),
    ];
    const analysis = analyzeScreen(elements);
    expect(analysis.texts.length).toBe(1);
    expect(analysis.texts[0].content).toBe("Hello World");
  });

  it("includes screenTitle in analysis", () => {
    const elements: UiElement[] = [
      makeTestElement({
        className: "android.widget.Toolbar", text: "My Screen",
        bounds: { x1: 0, y1: 0, x2: 1080, y2: 56 },
      }),
    ];
    const analysis = analyzeScreen(elements);
    expect(analysis.screenTitle).toBe("My Screen");
  });

  it("includes navigation state", () => {
    const elements: UiElement[] = [
      makeTestElement({ contentDesc: "Navigate up", clickable: true }),
      makeTestElement({ contentDesc: "More options", clickable: true }),
    ];
    const analysis = analyzeScreen(elements);
    expect(analysis.navigationState).toBeDefined();
    expect(analysis.navigationState!.hasBack).toBe(true);
    expect(analysis.navigationState!.hasMenu).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Feature 4: diffUiElements
// ──────────────────────────────────────────────

describe("diffUiElements", () => {
  it("detects no changes for identical lists", () => {
    const elements = parseUiHierarchy(SAMPLE_XML);
    const diff = diffUiElements(elements, elements);
    expect(diff.appeared.length).toBe(0);
    expect(diff.disappeared.length).toBe(0);
    expect(diff.screenChanged).toBe(false);
  });

  it("detects appeared elements", () => {
    const before: UiElement[] = [
      makeTestElement({ text: "Login", className: "Button" }),
    ];
    const after: UiElement[] = [
      makeTestElement({ text: "Login", className: "Button" }),
      makeTestElement({ text: "Welcome", className: "TextView" }),
    ];
    const diff = diffUiElements(before, after);
    expect(diff.appeared.length).toBe(1);
    expect(diff.appeared[0]).toContain("Welcome");
  });

  it("detects disappeared elements", () => {
    const before: UiElement[] = [
      makeTestElement({ text: "Login", className: "Button" }),
      makeTestElement({ text: "Register", className: "Button" }),
    ];
    const after: UiElement[] = [
      makeTestElement({ text: "Login", className: "Button" }),
    ];
    const diff = diffUiElements(before, after);
    expect(diff.disappeared.length).toBe(1);
    expect(diff.disappeared[0]).toContain("Register");
  });

  it("detects screen change when >60% elements differ", () => {
    const before: UiElement[] = [
      makeTestElement({ text: "A", className: "View" }),
      makeTestElement({ text: "B", className: "View" }),
      makeTestElement({ text: "C", className: "View" }),
    ];
    const after: UiElement[] = [
      makeTestElement({ text: "X", className: "View" }),
      makeTestElement({ text: "Y", className: "View" }),
      makeTestElement({ text: "Z", className: "View" }),
    ];
    const diff = diffUiElements(before, after);
    expect(diff.screenChanged).toBe(true);
  });

  it("handles empty before list", () => {
    const after: UiElement[] = [
      makeTestElement({ text: "New", className: "View" }),
    ];
    const diff = diffUiElements([], after);
    expect(diff.appeared.length).toBe(1);
    expect(diff.beforeCount).toBe(0);
    expect(diff.afterCount).toBe(1);
  });
});

// ──────────────────────────────────────────────
// Feature 4: suggestNextActions
// ──────────────────────────────────────────────

describe("suggestNextActions", () => {
  it("suggests input for focused EditText", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "android.widget.EditText", focused: true, contentDesc: "Username" }),
    ];
    const suggestions = suggestNextActions(elements);
    expect(suggestions.some(s => s.includes("input_text"))).toBe(true);
    expect(suggestions.some(s => s.includes("Username"))).toBe(true);
  });

  it("suggests dialog buttons", () => {
    const elements: UiElement[] = [
      makeTestElement({ text: "OK", clickable: true, className: "Button" }),
      makeTestElement({ text: "Cancel", clickable: true, className: "Button" }),
    ];
    const suggestions = suggestNextActions(elements);
    expect(suggestions.some(s => s.includes("OK") && s.includes("Cancel"))).toBe(true);
  });

  it("suggests scroll when scrollable", () => {
    const elements: UiElement[] = [
      makeTestElement({ className: "android.widget.ScrollView", scrollable: true }),
    ];
    const suggestions = suggestNextActions(elements);
    expect(suggestions.some(s => s.includes("scroll"))).toBe(true);
  });

  it("returns empty for empty screen", () => {
    const suggestions = suggestNextActions([]);
    expect(suggestions).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeTestElement(overrides: Partial<UiElement>): UiElement {
  const defaults: UiElement = {
    index: 0,
    resourceId: "",
    className: "android.widget.View",
    packageName: "com.test",
    text: "",
    contentDesc: "",
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
    centerX: 50,
    centerY: 25,
    width: 100,
    height: 50,
  };
  const el = { ...defaults, ...overrides };
  if (overrides.bounds) {
    el.width = el.bounds.x2 - el.bounds.x1;
    el.height = el.bounds.y2 - el.bounds.y1;
    el.centerX = Math.floor((el.bounds.x1 + el.bounds.x2) / 2);
    el.centerY = Math.floor((el.bounds.y1 + el.bounds.y2) / 2);
  }
  return el;
}
