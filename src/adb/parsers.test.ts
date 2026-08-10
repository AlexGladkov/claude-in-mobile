import { describe, it, expect } from "vitest";
import { parseWindowSecureFlag } from "./parsers.js";

// Trimmed, realistic `dumpsys window` shapes. Two windows; the flag lives in
// the per-window `mAttrs { ... fl=... }` block, and the focus is named at the end.
function dump(opts: {
  focus: string;
  windows: Array<{ n: number; title: string; secure: boolean }>;
}): string {
  const blocks = opts.windows
    .map(
      (w) =>
        `  Window #${w.n} Window{deadbeef u0 ${w.title}}:\n` +
        `    mOwnerUid=10123 showForAllUsers=false\n` +
        `    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION fmt=TRANSLUCENT\n` +
        `      fl=LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR${w.secure ? " SECURE" : ""} HARDWARE_ACCELERATED}\n`,
    )
    .join("\n");
  return `WINDOW MANAGER WINDOWS (dumpsys window windows)\n${blocks}\n  mCurrentFocus=Window{deadbeef u0 ${opts.focus}}\n  mFocusedApp=AppWindowToken{...}\n`;
}

describe("parseWindowSecureFlag", () => {
  it("returns true when the focused window has FLAG_SECURE", () => {
    const out = dump({
      focus: "com.bank/com.bank.MainActivity",
      windows: [{ n: 1, title: "com.bank/com.bank.MainActivity", secure: true }],
    });
    expect(parseWindowSecureFlag(out)).toBe(true);
  });

  it("returns false when the focused window is not secure", () => {
    const out = dump({
      focus: "com.example/com.example.Home",
      windows: [{ n: 1, title: "com.example/com.example.Home", secure: false }],
    });
    expect(parseWindowSecureFlag(out)).toBe(false);
  });

  it("ignores SECURE on a background window when the focused one is not secure", () => {
    const out = dump({
      focus: "com.example/com.example.Home",
      windows: [
        { n: 1, title: "com.bank/com.bank.MainActivity", secure: true }, // background
        { n: 2, title: "com.example/com.example.Home", secure: false }, // focused
      ],
    });
    expect(parseWindowSecureFlag(out)).toBe(false);
  });

  it("falls back to global presence when focus cannot be isolated", () => {
    const out =
      "  Window #1 Window{deadbeef u0 some.app/Act}:\n" +
      "    mAttrs={ fl=LAYOUT_IN_SCREEN SECURE HARDWARE_ACCELERATED}\n";
    // no mCurrentFocus line → focus token unresolved → conservative global match
    expect(parseWindowSecureFlag(out)).toBe(true);
  });

  it("returns false for an empty / unparseable dump", () => {
    expect(parseWindowSecureFlag("")).toBe(false);
    expect(parseWindowSecureFlag("garbage output")).toBe(false);
  });
});
