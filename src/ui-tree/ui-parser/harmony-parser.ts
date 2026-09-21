import { z } from "zod";
import type { Bounds, UiElement } from "./types.js";

interface JsonObject {
  [key: string]: unknown;
}

const harmonyObjectSchema = z.record(z.string().max(256), z.unknown());
const harmonyHierarchyRootSchema = z.union([
  harmonyObjectSchema,
  z.array(z.unknown()).max(50_000),
]);

const HARMONY_CHILD_KEYS: Readonly<Record<string, true>> = Object.freeze({
  children: true,
  child: true,
  nodes: true,
  windows: true,
});
function parseHarmonyObject(value: unknown): JsonObject | undefined {
  const result = harmonyObjectSchema.safeParse(value);
  return result.success ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 4096);
  }
  return "";
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseBounds(value: unknown): Bounds {
  if (typeof value === "string") {
    const match = value.match(
      /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/,
    );
    if (match) {
      return {
        x1: Number(match[1]),
        y1: Number(match[2]),
        x2: Number(match[3]),
        y2: Number(match[4]),
      };
    }
  }
  const object = parseHarmonyObject(value);
  if (object) {
    const x1 = numberValue(object.left ?? object.x1 ?? object.x);
    const y1 = numberValue(object.top ?? object.y1 ?? object.y);
    const width = numberValue(object.width);
    const height = numberValue(object.height);
    const x2 = numberValue(object.right ?? object.x2)
      ?? (x1 !== undefined && width !== undefined ? x1 + width : undefined);
    const y2 = numberValue(object.bottom ?? object.y2)
      ?? (y1 !== undefined && height !== undefined ? y1 + height : undefined);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      return { x1, y1, x2, y2 };
    }
  }
  return { x1: 0, y1: 0, x2: 0, y2: 0 };
}

function firstString(source: JsonObject, keys: readonly string[]): string {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) return value;
  }
  return "";
}

/** Convert ArkXTest `uitest dumpLayout` JSON into the shared UiElement model. */
export function harmonyHierarchyToUiElements(raw: string | unknown): UiElement[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("HarmonyOS UI hierarchy is not valid JSON.");
  }
  const rootResult = harmonyHierarchyRootSchema.safeParse(parsed);
  if (!rootResult.success) {
    throw new Error("HarmonyOS UI hierarchy has an invalid root.");
  }

  const elements: UiElement[] = [];
  const seen = new Set<JsonObject>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (++visited > 50_000 || current.depth > 64) {
      throw new Error("HarmonyOS UI hierarchy exceeds the complexity limit.");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 50_000) {
        throw new Error("HarmonyOS UI hierarchy exceeds the array limit.");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    const value = parseHarmonyObject(current.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const parsedAttributes = parseHarmonyObject(value.attributes);
    const attributes = parsedAttributes ?? value;
    const isNode = parsedAttributes !== undefined
      || "bounds" in attributes
      || "type" in attributes
      || "id" in attributes;
    if (isNode) {
      if (elements.length >= 50_000) {
        throw new Error("HarmonyOS UI hierarchy exceeds the element limit.");
      }
      const bounds = parseBounds(attributes.bounds ?? value.bounds);
      const width = Math.max(0, bounds.x2 - bounds.x1);
      const height = Math.max(0, bounds.y2 - bounds.y1);
      elements.push({
        index: elements.length,
        resourceId: firstString(attributes, ["id", "resourceId", "accessibilityId"]),
        className: firstString(attributes, ["type", "className", "role"]),
        packageName: firstString(attributes, ["bundleName", "packageName"]),
        text: firstString(attributes, ["text", "content", "value"]),
        contentDesc: firstString(attributes, ["description", "hint", "accessibilityText"]),
        checkable: booleanValue(attributes.checkable),
        checked: booleanValue(attributes.checked),
        clickable: booleanValue(attributes.clickable),
        enabled: attributes.enabled === undefined || booleanValue(attributes.enabled),
        focusable: booleanValue(attributes.focusable),
        focused: booleanValue(attributes.focused),
        scrollable: booleanValue(attributes.scrollable),
        longClickable: booleanValue(attributes.longClickable),
        password: booleanValue(attributes.password),
        selected: booleanValue(attributes.selected),
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        width,
        height,
      });
    }

    let foundChildren = false;
    for (const key in HARMONY_CHILD_KEYS) {
      if (value[key] !== undefined) {
        foundChildren = true;
        stack.push({ value: value[key], depth: current.depth + 1 });
      }
    }
    if (!isNode && !foundChildren) {
      for (const child of Object.values(value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return elements;
}
