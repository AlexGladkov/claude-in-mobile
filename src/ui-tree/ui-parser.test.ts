import { describe, it, expect } from "vitest";
import {
  parseUiHierarchy,
  findByText,
  findByResourceId,
  findByClassName,
  findClickable,
  findClickableAncestor,
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
  it("does not expose matched element values in scoring reasons", () => {
    const secret = "731904";
    const secure = makeTestElement({
      className: "android.widget.EditText",
      resourceId: `com.example:id/otp_${secret}`,
      text: secret,
    });

    const result = findBestMatch([secure], secret);

    expect(result?.reason).toBe("exact text match");
    expect(result?.reason).not.toContain(secret);
    expect(result?.reason).not.toContain("otp_");
    expect(formatElement(secure)).not.toContain(secret);
    expect(formatElement(secure)).not.toContain("otp_");
  });
});

// ──────────────────────────────────────────────
// findClickableAncestor
// ──────────────────────────────────────────────

describe("findClickableAncestor", () => {
  // Pattern common in MAUI/Compose: visible TextView is non-clickable, but the
  // parent ViewGroup at the same/larger bounds carries the gesture handler.
  const textChild = makeTestElement({
    text: "Products",
    clickable: false,
    bounds: { x1: 360, y1: 920, x2: 470, y2: 970 },
  });
  const clickableParent = makeTestElement({
    className: "android.view.ViewGroup",
    clickable: true,
    bounds: { x1: 320, y1: 760, x2: 510, y2: 980 },
  });
  const screenRoot = makeTestElement({
    className: "android.widget.FrameLayout",
    clickable: true,
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
  });

  it("returns null when target is itself clickable", () => {
    const target = makeTestElement({ text: "OK", clickable: true });
    const result = findClickableAncestor(target, [target, clickableParent]);
    expect(result).toBeNull();
  });

  it("finds smallest clickable ancestor that contains target bounds", () => {
    const result = findClickableAncestor(textChild, [textChild, clickableParent, screenRoot]);
    expect(result).not.toBeNull();
    expect(result).toBe(clickableParent);
  });

  it("ignores ancestor candidates that don't contain target bounds", () => {
    const otherClickable = makeTestElement({
      clickable: true,
      bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, // far from target
    });
    const result = findClickableAncestor(textChild, [textChild, otherClickable]);
    expect(result).toBeNull();
  });

  it("rejects screen-root containers via maxAreaMultiplier heuristic", () => {
    // Only candidate is the full-screen container — far larger than target × 200
    const result = findClickableAncestor(textChild, [textChild, screenRoot]);
    expect(result).toBeNull();
  });

  it("accepts large containers when maxAreaMultiplier is loosened", () => {
    const result = findClickableAncestor(textChild, [textChild, screenRoot], { maxAreaMultiplier: 100_000 });
    expect(result).toBe(screenRoot);
  });

  it("returns null when no clickable ancestors at all", () => {
    const result = findClickableAncestor(textChild, [textChild]);
    expect(result).toBeNull();
  });

  it("ignores disabled clickable ancestors", () => {
    const disabledParent = { ...clickableParent, enabled: false };
    const result = findClickableAncestor(textChild, [textChild, disabledParent]);
    expect(result).toBeNull();
  });
});

// ──────────────────────────────────────────────
// findBestMatch — walkToClickable behavior
// ──────────────────────────────────────────────

describe("findBestMatch walkToClickable", () => {
  const textChild = makeTestElement({
    text: "Products",
    clickable: false,
    bounds: { x1: 360, y1: 920, x2: 470, y2: 970 },
  });
  const clickableParent = makeTestElement({
    className: "android.view.ViewGroup",
    clickable: true,
    bounds: { x1: 320, y1: 760, x2: 510, y2: 980 },
  });

  it("walks up to clickable ancestor by default when match is non-clickable", () => {
    const result = findBestMatch([textChild, clickableParent], "Products");
    expect(result).not.toBeNull();
    expect(result!.element).toBe(clickableParent);
    expect(result!.reason).toContain("via clickable ancestor");
  });

  it("returns matched element when walkToClickable is false", () => {
    const result = findBestMatch([textChild, clickableParent], "Products", { walkToClickable: false });
    expect(result).not.toBeNull();
    expect(result!.element).toBe(textChild);
    expect(result!.reason).not.toContain("via clickable ancestor");
  });

  it("returns matched element directly when it is itself clickable", () => {
    const directButton = makeTestElement({ text: "Save", clickable: true });
    const result = findBestMatch([directButton], "Save");
    expect(result).not.toBeNull();
    expect(result!.element).toBe(directButton);
    expect(result!.reason).not.toContain("via clickable ancestor");
  });

  it("falls back to original match when no clickable ancestor exists", () => {
    const result = findBestMatch([textChild], "Products");
    expect(result).not.toBeNull();
    expect(result!.element).toBe(textChild);
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
  it("redacts secure button labels and input hints while preserving ordinary labels", () => {
    const analysis = analyzeScreen([
      makeTestElement({
        index: 1,
        className: "android.widget.Button",
        password: true,
        clickable: true,
        text: "hunter2",
        contentDesc: "Private action",
      }),
      makeTestElement({
        index: 2,
        className: "securetextbox",
        text: "123456",
        contentDesc: "Private PIN name",
      }),
      makeTestElement({
        index: 3,
        className: "android.widget.Button",
        clickable: true,
        text: "Continue",
        contentDesc: "Continue setup",
      }),
    ]);

    expect(analysis.buttons.find(button => button.index === 1)?.label).toBe("[REDACTED]");
    expect(analysis.inputs.find(input => input.index === 2)?.hint).toBe("[REDACTED]");
    expect(analysis.buttons.find(button => button.index === 3)?.label).toBe("Continue");

    const formatted = formatScreenAnalysis(analysis);
    expect(formatted).not.toContain("hunter2");
    expect(formatted).not.toContain("123456");
    expect(formatted).not.toContain("Private action");
    expect(formatted).not.toContain("Private PIN name");
    expect(formatted).toContain("Continue");
  });
  it("redacts OTP/PIN values identified by resource metadata", () => {
    const otp = makeTestElement({
      index: 4,
      className: "android.widget.EditText",
      resourceId: "com.example:id/otp_input",
      text: "731904",
      contentDesc: "One-time code",
    });

    const formattedElement = formatElement(otp);
    const formattedAnalysis = formatScreenAnalysis(analyzeScreen([otp]));
    expect(formattedElement).not.toContain("731904");
    expect(formattedElement).toContain("[REDACTED]");
    expect(formattedAnalysis).not.toContain("731904");
    expect(formattedAnalysis).toContain("[REDACTED]");
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
  it.each(["password", "securetextbox"])("redacts lowercase secure role %s", (role) => {
    const secure = makeTestElement({
      className: role,
      text: "hunter2",
      contentDesc: "Private password field",
    });

    const formatted = formatElement(secure);

    expect(formatted).not.toContain("hunter2");
    expect(formatted).not.toContain("Private password field");
    expect(formatted).toContain('text="[REDACTED]"');
    expect(formatted).toContain('desc="[REDACTED]"');
  });

  it("redacts populated Android and Harmony text-entry values", () => {
    const androidField = makeTestElement({
      className: "android.widget.EditText",
      text: "731904",
      clickable: true,
      focused: true,
    });
    const harmonyField = makeTestElement({
      className: "Harmony.TextInput",
      text: "harmony-otp-value",
      clickable: true,
    });
    const otpDescription = makeTestElement({
      className: "android.widget.Button",
      text: "Continue",
      contentDesc: "OTP 482617",
      clickable: true,
    });
    const elements = [androidField, harmonyField, otpDescription];
    const full = formatUiTree(elements, { showAll: true });
    const compact = formatUiTree(elements, { compact: true });
    const suggestions = suggestNextActions(elements).join("\n");

    for (const output of [full, compact, suggestions]) {
      expect(output).not.toContain("731904");
      expect(output).not.toContain("harmony-otp-value");
      expect(output).not.toContain("482617");
    }
  });

  it("redacts IDs for empty generic text-entry fields", () => {
    const identifier = "customer-account-5841";
    const element = makeTestElement({
      className: "android.widget.EditText",
      resourceId: identifier,
      text: "",
      contentDesc: "Email address",
    });
    const formatted = formatElement(element);

    expect(formatted).not.toContain(identifier);
    expect(formatted).toContain('desc="Email address"');
  });

  it("removes terminal controls from device-provided UI and analysis values", () => {
    const attack = "Visible\u001b[31mred\u001b[0m\nINJECTED\u0007\u202eRTL\u202c\u2066isolated\u2069";
    const element = makeTestElement({
      className: `android.widget.Button${attack}`,
      resourceId: `com.test:id/button${attack}`,
      text: attack,
      contentDesc: attack,
      clickable: true,
    });
    const formatted = formatElement(element);
    const compact = formatUiTree([element], { compact: true });
    const analysis = formatScreenAnalysis({
      summary: attack,
      screenTitle: attack,
      hasDialog: true,
      dialogTitle: attack,
      navigationState: {
        hasBack: true,
        hasMenu: true,
        hasTabs: true,
        currentTab: attack,
      },
      buttons: [{ index: 0, label: attack, coordinates: { x: 1, y: 2 } }],
      inputs: [{
        index: 1,
        hint: attack,
        value: attack,
        coordinates: { x: 3, y: 4 },
      }],
      texts: [{ content: attack, coordinates: { x: 5, y: 6 } }],
      scrollable: [],
    });

    expect(formatted).not.toContain("\u001b");
    expect(formatted.split("\n")).toHaveLength(1);
    expect(compact).not.toContain("\u001b");
    expect(compact.split("\n")).toHaveLength(1);
    expect(analysis).not.toContain("\u001b");
    expect(formatted).not.toContain("\u202e");
    expect(formatted).not.toContain("\u202c");
    expect(formatted).not.toContain("\u2066");
    expect(formatted).not.toContain("\u2069");
    expect(compact).not.toContain("\u202e");
    expect(analysis).not.toContain("\u2069");
    expect(analysis.split("\n")).toHaveLength(15);
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
    const lines = tree.split("\n");
    // 2 element lines + 1 truncation notice line
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("showing 2 of");
  });

  it("returns 'No UI elements found' for empty array", () => {
    const tree = formatUiTree([]);
    expect(tree).toBe("No UI elements found");
  });
  it("redacts secure text and descriptions in full-tree output", () => {
    const tree = formatUiTree([
      makeTestElement({
        className: "securetextbox",
        text: "hunter2",
        contentDesc: "Private PIN name",
      }),
    ], { showAll: true });

    expect(tree).not.toContain("hunter2");
    expect(tree).not.toContain("Private PIN name");
    expect(tree).toContain("<securetextbox>");
    expect(tree).toContain('text="[REDACTED]"');
    expect(tree).toContain('desc="[REDACTED]"');
    expect(tree).toContain("@ (50, 25)");
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
  it("does not print a value marked as sensitive", () => {
    const analysis = analyzeScreen([
      makeTestElement({
        className: "XCUIElementTypeTextField",
        password: true,
        text: "",
        contentDesc: "pin_input",
      }),
    ]);
    analysis.inputs[0].value = "123456";

    const formatted = formatScreenAnalysis(analysis);

    expect(formatted).not.toContain("123456");
    expect(formatted).toContain("[REDACTED]");
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
  it("does not retain secure values when hints do not identify the field", () => {
    const analysis = analyzeScreen([
      makeTestElement({
        className: "XCUIElementTypeTextField",
        password: true,
        text: "123456",
        contentDesc: "",
        resourceId: "pin_input",
      }),
    ]);

    expect(analysis.inputs[0].value).toBe("");
    expect(analysis.inputs[0].sensitive).toBe(true);
    expect(formatScreenAnalysis(analysis)).not.toContain("123456");
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
