import type { UiElement } from "../types.js";
import { safeTerminalText } from "../../../utils/terminal-controls.js";

/** Placeholder shown instead of the value of a password/secure field. */
export const REDACTED = "[REDACTED]";

/**
 * Normalize class/role-like identifiers before checking security markers.
 *
 * Provider adapters use different spellings (`SecureTextField`,
 * `secure-textbox`, and `password` are all observed), so classification must
 * be case-insensitive and tolerant of separators.
 */
function hasSecureMarker(value: string): boolean {
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u);
  const compact = words.join("");
  return words.some((word) =>
    word === "pin"
      || word === "otp"
      || /^(?:pin|otp)(?:code|number|value)$/.test(word)
  )
    || compact.includes("password")
    || compact.includes("passcode")
    || compact.includes("securetextfield")
    || compact.includes("securetextbox")
    || compact.includes("onetimecode")
    || compact.includes("verificationcode")
    || compact.includes("securitycode")
    || compact.includes("creditcard")
    || compact.includes("cardnumber")
    || compact.includes("ccnumber")
    || compact.includes("ccsecuritycode")
    || compact.includes("cvv")
    || compact.includes("cvc")
    || compact === "secure";
}

export function isTextEntryIdentifier(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const compact = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return compact === "input"
    || compact === "email"
    || compact === "url"
    || compact === "tel"
    || compact === "number"
    || compact.includes("edittext")
    || compact.includes("textbox")
    || compact.includes("textfield")
    || compact.includes("textinput")
    || compact.includes("textarea")
    || compact.includes("searchbox")
    || compact.includes("searchfield")
    || compact.includes("searchbar")
    || compact.includes("combobox")
    || compact.includes("spinbutton");
}

/**
 * Whether an element's textual value must be hidden from output.
 *
 * Covers both the parser-provided `password` flag (Android `password="true"`,
 * iOS `SecureTextField`/`Password` class) and class/role/resource-id
 * fallbacks so secure fields are never leaked regardless of how they were
 * normalized by a provider.
 */
type ElementSensitivityMetadata =
  & Pick<UiElement, "className" | "resourceId">
  & Partial<UiElement>
  & { role?: unknown };

export function isSecureElement(el: ElementSensitivityMetadata): boolean {
  if (el.password) return true;
  const className = typeof el.className === "string" ? el.className : "";
  const resourceId = typeof el.resourceId === "string" ? el.resourceId : "";
  const contentDesc = typeof el.contentDesc === "string" ? el.contentDesc : "";
  const role = typeof el.role === "string" ? el.role : "";
  return hasSecureMarker(className)
    || hasSecureMarker(role)
    || hasSecureMarker(resourceId)
    || hasSecureMarker(contentDesc)
    || (Boolean(el.text)
      && (isTextEntryIdentifier(className) || isTextEntryIdentifier(role)));
}

/** Autopilot records also hide empty text-entry fields and their dynamic IDs. */
export function isSensitiveElement(el: ElementSensitivityMetadata): boolean {
  const role = typeof el.role === "string" ? el.role : "";
  return isSecureElement(el)
    || isTextEntryIdentifier(el.className)
    || isTextEntryIdentifier(role)
    || isTextEntryIdentifier(el.resourceId);
}

/**
 * Return the label safe to display for an element: the placeholder for secure
 * fields, otherwise the element's own text/contentDesc-derived label.
 */
export function safeLabel(el: UiElement, rawLabel: string): string {
  return safeTerminalText(isSecureElement(el) ? REDACTED : rawLabel);
}
