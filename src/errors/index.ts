/**
 * Typed error classes for better error classification and handling.
 * Enables Claude to auto-suggest fixes and enables smart retry logic.
 *
 * Barrel module — re-exports every category. Import from `../errors.js`
 * or `./errors/index.js`; both are equivalent.
 */

export * from "./base.js";
export * from "./device.js";
export * from "./adb.js";
export * from "./ios.js";
export * from "./browser.js";
export * from "./protocol.js";
export * from "./visual.js";
export * from "./recorder.js";
export * from "./sync.js";
export * from "./a11y.js";
export * from "./autopilot.js";
export * from "./perf.js";
