import { z } from "zod";
import { sanitizeErrorMessage, sanitizeResourceUri } from "mcp-devices/utils/sanitize";
import { safeTerminalText } from "mcp-devices/utils/terminal-controls";

import type { PluginUiElement } from "@mcp-devices/plugin-api";
import type { BrowserSession } from "./types.js";
import type { CDPClientInterface, CDPAccessibilityNode } from "./cdp-types.js";
// Selector resolution is kept local so every Runtime remote object created by
// a projection can be released before the projection guard is cleared.
const MAX_AX_NODES = 5000;
const MAX_INTERACTIVE_REFS = 200;
const MAX_SNAPSHOT_LINES = 1000;
const MAX_SNAPSHOT_CHARS = 1024 * 1024;
const MAX_BROWSER_UI_STRING_CHARS = 8_192;
const MAX_BROWSER_UI_TOTAL_STRING_CHARS = 1_048_576;
// AX trees can contain thousands of nodes. DOM metadata is useful only for
// actionable controls and fields whose contents need security classification,
// so keep this work bounded independently of the AX tree size.
const MAX_UI_DOM_PROBES = 128;
const MAX_UI_DOM_CONCURRENCY = 8;
const UI_DOM_DEADLINE_MS = 200;
const MAX_SNAPSHOT_SELECTOR_PROBES = 128;
const SECURE_MARKER_RE =
  /(?:password|passcode|secret|credential|secure|one[\s_-]*time[\s_-]*code|verification[\s_-]*code|security[\s_-]*code|credit[\s_-]*card|card[\s_-]*number|cc[\s_-]*(?:number|security[\s_-]*code)|cvv|cvc|(?:^|[^a-z0-9])(?:otp|pin)(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:otp|pin)(?:code|number|value|field))/iu;
const SECURE_PROPERTY_NAMES: Readonly<Record<string, true>> = {
  password: true,
  secure: true,
  issecure: true,
  inputtype: true,
  autocomplete: true,
  type: true,
};
const INTERACTIVE_ROLES: Readonly<Record<string, true>> = {
  button: true,
  link: true,
  textbox: true,
  combobox: true,
  listbox: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  radio: true,
  checkbox: true,
  switch: true,
  slider: true,
  spinbutton: true,
  tab: true,
  treeitem: true,
  option: true,
  searchbox: true,
  scrollbar: true,
  columnheader: true,
  rowheader: true,
};
const TEXT_ENTRY_ROLES: Readonly<Record<string, true>> = {
  textbox: true,
  combobox: true,
  spinbutton: true,
  searchbox: true,
};
const SCROLLABLE_ROLES: Readonly<Record<string, true>> = {
  list: true,
  grid: true,
  tree: true,
  scrollbar: true,
};
const cdpValueSchema = z.object({
  type: z.enum(["string", "computedString"]),
  value: z.string().max(64 * 1024),
}).passthrough();
const runtimeStringResultSchema = z.object({
  result: z.object({
    value: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  }).passthrough(),
}).passthrough();


/**
 * Accessibility-tree → text snapshot transformer. Pulled out of BrowserClient
 * so the class focuses on CDP session lifecycle; this module owns the
 * AX→UI projection rules.
 */


function formatValue(value: unknown): string | undefined {
  const parsed = cdpValueSchema.safeParse(value);
  return parsed.success ? parsed.data.value : undefined;
}

/**
 * Keep browser URLs useful for navigation diagnostics without exposing
 * credentials, query parameters, or fragments that commonly carry tokens.
 */
export function sanitizeBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const originAndPath = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return safeTerminalText(
      originAndPath
      + (parsed.search ? "?[REDACTED]" : "")
      + (parsed.hash ? "#[REDACTED]" : ""),
    );
  } catch {
    const withoutCredentials = value.replace(
      /([a-z][a-z\d+.-]*:\/\/)(?:[^/@\s]+@)/iu,
      "$1",
    );
    return safeTerminalText(
      withoutCredentials.replace(/[?#].*$/u, (marker) => `${marker[0]}[REDACTED]`),
    );
  }
}
function sanitizeBrowserTitle(value: string): string {
  try {
    new URL(value);
  } catch {
    return safeTerminalText(sanitizeErrorMessage(value));
  }
  return safeTerminalText(sanitizeResourceUri(value) ?? "[REDACTED]");
}

function propertyValue(
  node: CDPAccessibilityNode,
  propertyName: string,
): unknown {
  return node.properties?.find((property) => property.name === propertyName)?.value.value;
}

function containsSecureMarker(value: unknown): boolean {
  return typeof value === "string" && SECURE_MARKER_RE.test(value);
}

function isSecureAccessibilityNode(node: CDPAccessibilityNode): boolean {
  const role = (formatValue(node.role) ?? "").toLowerCase();
  const name = formatValue(node.name) ?? "";
  const value = formatValue(node.value);
  if (role === "password") return true;
  if (containsSecureMarker(name) || containsSecureMarker(value)) return true;

  for (const property of node.properties ?? []) {
    if (
      Object.hasOwn(SECURE_PROPERTY_NAMES, property.name.toLowerCase())
      && (
        property.value.value === true
        || containsSecureMarker(property.value.value)
      )
    ) {
      return true;
    }
    if (containsSecureMarker(property.name) || containsSecureMarker(property.value.value)) {
      return true;
    }
  }

  return false;
}

interface DomNodeDetails {
  nodeId?: number;
  id?: string;
  secure: boolean;
  textEntry?: boolean;
  securityClassificationComplete: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  geometryComplete: boolean;
}

interface DomProbeCandidate {
  readonly key: number;
  readonly node: CDPAccessibilityNode;
  readonly accessibilitySecure: boolean;
  readonly needsSecurity: boolean;
  readonly needsGeometry: boolean;
  readonly needsNodeId: boolean;
  readonly needsMetadata: boolean;
}

interface ProjectionBudget {
  readonly deadline: number;
  expired: boolean;
}

interface RuntimeWithRelease {
  releaseObject?(params: { objectId: string }): Promise<void>;
  releaseObjectGroup?(params: { objectGroup: string }): Promise<void>;
}

class ProjectionWork {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.active.delete(tracked);
    });
    this.active.add(tracked);
    // A timed-out race still has to observe a later rejection.
    void tracked.catch(() => {});
    return tracked;
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
  isIdle(): boolean {
    return this.active.size === 0;
  }
}
function clearProjectionGuard<T>(
  map: WeakMap<BrowserSession, Promise<T>>,
  session: BrowserSession,
  projection: Promise<T>,
  work: ProjectionWork,
): void {
  const clear = (): void => {
    if (map.get(session) === projection) {
      map.delete(session);
    }
  };
  if (work.isIdle()) {
    clear();
    return;
  }
  void work.waitForIdle().then(clear);
}

type ProbeOutcome<T> =
  | { status: "done"; value: T }
  | { status: "failed" }
  | { status: "timeout" };

function createProjectionBudget(): ProjectionBudget {
  return {
    deadline: Date.now() + UI_DOM_DEADLINE_MS,
    expired: false,
  };
}

function remainingBudget(budget: ProjectionBudget): number {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) budget.expired = true;
  return Math.max(0, remaining);
}

function startTracked<T>(
  work: ProjectionWork,
  operation: () => Promise<T>,
): Promise<T> {
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(operation());
  } catch (error: unknown) {
    promise = Promise.reject(error);
  }
  return work.track(promise);
}

async function settleWithinBudget<T>(
  operation: Promise<T>,
  budget: ProjectionBudget,
): Promise<ProbeOutcome<T>> {
  const remaining = remainingBudget(budget);
  if (remaining === 0) return { status: "timeout" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      budget.expired = true;
      resolve({ status: "timeout" });
    }, remaining);
  });
  const settled = operation.then(
    (value): ProbeOutcome<T> => ({ status: "done", value }),
    (): ProbeOutcome<T> => ({ status: "failed" }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function defaultDomNodeDetails(candidate: DomProbeCandidate): DomNodeDetails {
  return {
    secure: candidate.accessibilitySecure,
    textEntry: false,
    securityClassificationComplete: !candidate.needsMetadata || candidate.accessibilitySecure,
    geometryComplete: !candidate.needsGeometry,
    nodeId: undefined,
  };
}

function securityProbeRequired(
  node: CDPAccessibilityNode,
  role: string,
  rawName: string,
  value: string | undefined,
  accessibilitySecure: boolean,
): boolean {
  if (accessibilitySecure) return false;
  if (
    value !== undefined
    || isTextEntryRole(role)
  ) {
    return true;
  }
  if (containsSecureMarker(rawName)) return true;
  return (node.properties ?? []).some((property) =>
    containsSecureMarker(property.name) || containsSecureMarker(property.value.value),
  );
}

function isTextEntryRole(role: string): boolean {
  return Object.hasOwn(TEXT_ENTRY_ROLES, role.toLowerCase());
}

function hasValueBearingTextInput(role: string, value: string | undefined): boolean {
  return Boolean(value) && isTextEntryRole(role);
}

async function resolveBounds(
  cdp: CDPClientInterface,
  nodeId: number,
  details: DomNodeDetails,
  budget: ProjectionBudget,
  work: ProjectionWork,
): Promise<void> {
  if (budget.expired || remainingBudget(budget) === 0) return;
  const result = await settleWithinBudget(
    startTracked(work, () => cdp.DOM.getBoxModel({ nodeId })),
    budget,
  );
  if (result.status !== "done") return;

  try {
    const [x1, y1, x2, , , , , y4] = result.value.model.content;
    if (
      Number.isFinite(x1)
      && Number.isFinite(y1)
      && Number.isFinite(x2)
      && Number.isFinite(y4)
    ) {
      details.bounds = {
        x: x1,
        y: y1,
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y4 - y1),
      };
      details.geometryComplete = true;
    }
  } catch {}
}

const DOM_METADATA_FUNCTION = `function() {
  const tagName = this.tagName.toLowerCase();
  const type = (this.getAttribute("type") || "text").toLowerCase();
  const nonTextInputTypes = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "reset", "submit"];
  return {
    id: this.id || "",
    type,
    autocomplete: this.getAttribute("autocomplete") || "",
    ariaRole: this.getAttribute("role") || "",
    textEntry: tagName === "textarea"
      || this.isContentEditable
      || (tagName === "input" && !nonTextInputTypes.includes(type))
  };
}`;

async function releaseRemoteObject(
  cdp: CDPClientInterface,
  objectId: string,
  budget: ProjectionBudget,
  work: ProjectionWork,
): Promise<void> {
  const runtime = cdp.Runtime as CDPClientInterface["Runtime"] & RuntimeWithRelease;
  if (typeof runtime.releaseObject !== "function") return;
  await settleWithinBudget(
    startTracked(work, () => runtime.releaseObject!({ objectId })),
    budget,
  );
}
const selectorResultSchema = z.object({
  result: z.object({
    value: z.string().max(16 * 1024),
  }).passthrough(),
}).passthrough();

const DOM_SELECTOR_FUNCTION = `function() {
  if (this.id) return '#' + CSS.escape(this.id);
  for (const attr of ['data-testid', 'data-test', 'data-cy']) {
    const value = this.getAttribute(attr);
    if (value) return '[' + attr + '=' + CSS.escape(value) + ']';
  }
  const parts = [];
  let el = this;
  while (el && el !== document.body) {
    let sel = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
    }
    parts.unshift(sel);
    el = parent;
  }
  return parts.join(' > ');
}`;

async function buildSelectorWithRelease(
  cdp: CDPClientInterface,
  nodeId: number,
  budget: ProjectionBudget,
  work: ProjectionWork,
): Promise<string> {
  if (budget.expired || remainingBudget(budget) === 0) return "";
  const resolved = await settleWithinBudget(
    startTracked(work, () => cdp.DOM.resolveNode({ nodeId })),
    budget,
  );
  if (resolved.status !== "done") return "";
  const objectId = resolved.value.object?.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) return "";

  try {
    const result = await settleWithinBudget(
      startTracked(work, () => cdp.Runtime.callFunctionOn({
        objectId,
        returnByValue: true,
        functionDeclaration: DOM_SELECTOR_FUNCTION,
      })),
      budget,
    );
    if (result.status !== "done") return "";
    const parsed = selectorResultSchema.safeParse(result.value);
    return parsed.success ? parsed.data.result.value : "";
  } finally {
    await releaseRemoteObject(cdp, objectId, budget, work);
  }
}

async function resolveSecurity(
  cdp: CDPClientInterface,
  nodeId: number,
  details: DomNodeDetails,
  budget: ProjectionBudget,
  work: ProjectionWork,
): Promise<void> {
  if (budget.expired || remainingBudget(budget) === 0) return;
  const resolved = await settleWithinBudget(
    startTracked(work, () => cdp.DOM.resolveNode({ nodeId })),
    budget,
  );
  if (resolved.status !== "done") return;

  const objectId = resolved.value.object?.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) return;

  try {
    const result = await settleWithinBudget(
      startTracked(work, () => cdp.Runtime.callFunctionOn({
        objectId,
        returnByValue: true,
        functionDeclaration: DOM_METADATA_FUNCTION,
      })),
      budget,
    );
    if (result.status !== "done") return;
    const metadata = result.value.result.value;
    if (typeof metadata !== "object" || metadata === null) return;
    const record = metadata as Record<string, unknown>;
    if (
      typeof record.id !== "string"
      || typeof record.type !== "string"
      || typeof record.autocomplete !== "string"
      || typeof record.ariaRole !== "string"
      || typeof record.textEntry !== "boolean"
    ) {
      return;
    }
    details.securityClassificationComplete = true;
    details.id = record.id || undefined;
    details.textEntry = record.textEntry || isTextEntryRole(record.ariaRole);
    details.secure = details.secure || [record.id, record.type, record.autocomplete, record.ariaRole]
      .some(containsSecureMarker);
  } catch {
    // An incomplete classification is handled as sensitive by the caller.
  } finally {
    await releaseRemoteObject(cdp, objectId, budget, work);
  }
}

async function resolveDomDetailsBatch(
  cdp: CDPClientInterface,
  candidates: readonly DomProbeCandidate[],
  budget: ProjectionBudget,
  work: ProjectionWork,
): Promise<Map<number, DomNodeDetails>> {
  const details = new Map<number, DomNodeDetails>();
  for (const candidate of candidates) {
    details.set(candidate.key, defaultDomNodeDetails(candidate));
  }

  const selected = candidates
    .filter((candidate) =>
      candidate.needsSecurity || candidate.needsGeometry || candidate.needsNodeId || candidate.needsMetadata,
    )
    .sort((left, right) => {
      // Security probes win the finite budget so fields cannot fall through
      // to an unclassified raw value merely because a large tree came first.
      const securityPriority = Number(right.needsSecurity) - Number(left.needsSecurity);
      return securityPriority || left.key - right.key;
    })
    .slice(0, MAX_UI_DOM_PROBES);
  if (selected.length === 0 || budget.expired || remainingBudget(budget) === 0) return details;

  const backendNodeIds = [
    ...new Set(
      selected
        .map((candidate) => candidate.node.backendDOMNodeId)
        .filter((backendNodeId): backendNodeId is number =>
          typeof backendNodeId === "number" && backendNodeId > 0,
        ),
    ),
  ];
  if (backendNodeIds.length === 0) return details;

  const pushed = await settleWithinBudget(
    startTracked(work, () => cdp.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds })),
    budget,
  );
  if (pushed.status !== "done") return details;

  const nodeIdsByBackend = new Map<number, number>();
  for (let index = 0; index < backendNodeIds.length; index++) {
    const nodeId = pushed.value.nodeIds?.[index];
    if (typeof nodeId === "number" && nodeId > 0) {
      nodeIdsByBackend.set(backendNodeIds[index], nodeId);
    }
  }

  let cursor = 0;
  const workerCount = Math.min(MAX_UI_DOM_CONCURRENCY, selected.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!budget.expired) {
      const candidate = selected[cursor++];
      if (!candidate) return;
      const nodeId = candidate.node.backendDOMNodeId === undefined
        ? undefined
        : nodeIdsByBackend.get(candidate.node.backendDOMNodeId);
      if (nodeId === undefined) continue;

      const candidateDetails = details.get(candidate.key);
      if (!candidateDetails) continue;
      candidateDetails.nodeId = nodeId;
      if (candidate.needsGeometry) {
        await resolveBounds(cdp, nodeId, candidateDetails, budget, work);
      }
      if (candidate.needsMetadata) {
        await resolveSecurity(cdp, nodeId, candidateDetails, budget, work);
      }
    }
  });
  await Promise.all(workers);
  return details;
}


const snapshotProjectionInFlight = new WeakMap<BrowserSession, Promise<string>>();

export function buildSnapshot(
  session: BrowserSession,
  cdp: CDPClientInterface,
): Promise<string> {
  const current = snapshotProjectionInFlight.get(session);
  if (current) return current;

  const work = new ProjectionWork();
  let projection!: Promise<string>;
  projection = buildSnapshotOnce(session, cdp, work).then(
    (result) => {
      clearProjectionGuard(snapshotProjectionInFlight, session, projection, work);
      return result;
    },
    (error: unknown) => {
      clearProjectionGuard(snapshotProjectionInFlight, session, projection, work);
      throw error;
    },
  );
  snapshotProjectionInFlight.set(session, projection);
  return projection;
}

async function buildSnapshotOnce(
  session: BrowserSession,
  cdp: CDPClientInterface,
  work: ProjectionWork,
): Promise<string> {
  let axNodes: CDPAccessibilityNode[];
  try {
    const result = await cdp.Accessibility.getFullAXTree();
    axNodes = result.nodes ?? [];
  } catch {
    return "(Failed to get accessibility tree)";
  }

  session.refMap.clear();
  session.lastRefCounter = 0;

  const snapshotLines: string[] = [];
  let snapshotChars = 0;
  const nodeLimit = Math.min(axNodes.length, MAX_AX_NODES);
  const candidates: DomProbeCandidate[] = [];
  const candidateByKey = new Map<number, DomProbeCandidate>();
  for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex++) {
    const node = axNodes[nodeIndex];
    if (node.ignored) continue;
    const role = formatValue(node.role) ?? "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
    const rawName = formatValue(node.name) ?? "";
    const value = formatValue(node.value);
    const accessibilitySecure = isSecureAccessibilityNode(node);
    const needsSecurity = securityProbeRequired(
      node,
      role.toLowerCase(),
      rawName,
      value,
      accessibilitySecure,
    );
    const needsNodeId = Object.hasOwn(INTERACTIVE_ROLES, role) && rawName.length > 0;
    if (!needsSecurity && !needsNodeId) continue;
    const candidate: DomProbeCandidate = {
      key: nodeIndex,
      node,
      accessibilitySecure,
      needsSecurity,
      needsGeometry: false,
      needsNodeId: true,
      needsMetadata: needsSecurity,
    };
    candidates.push(candidate);
    candidateByKey.set(nodeIndex, candidate);
  }

  const budget = createProjectionBudget();
  const details = await resolveDomDetailsBatch(cdp, candidates, budget, work);
  let selectorProbeCount = 0;

  for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex++) {
    const node = axNodes[nodeIndex];
    if (node.ignored) continue;
    const role = formatValue(node.role) ?? "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;

    const rawName = formatValue(node.name) ?? "";
    const accessibilitySecure = isSecureAccessibilityNode(node);
    const value = formatValue(node.value);
    const candidate = candidateByKey.get(nodeIndex);
    const domDetails = candidate ? details.get(nodeIndex) : undefined;
    const securityIncomplete = Boolean(
      candidate?.needsMetadata && domDetails?.securityClassificationComplete === false,
    );
    const textEntry = isTextEntryRole(role) || domDetails?.textEntry === true;
    const secure = accessibilitySecure
      || hasValueBearingTextInput(role, value)
      || domDetails?.secure === true
      || securityIncomplete;
    const safeRole = safeTerminalText(role);
    const name = safeTerminalText(secure ? "[REDACTED]" : rawName);

    let ref = "";
    if (
      Object.hasOwn(INTERACTIVE_ROLES, role)
      && name
      && session.lastRefCounter < MAX_INTERACTIVE_REFS
    ) {
      const refId = `e${++session.lastRefCounter}`;
      ref = ` [${refId}]`;

      let selector = "";
      if (
        !secure
        && !textEntry
        && domDetails?.nodeId
        && selectorProbeCount < MAX_SNAPSHOT_SELECTOR_PROBES
        && !budget.expired
      ) {
        selectorProbeCount++;
        selector = await buildSelectorWithRelease(cdp, domDetails.nodeId, budget, work);
      }

      session.refMap.set(refId, {
        selector,
        backendNodeId: node.backendDOMNodeId ?? 0,
        label: `${safeRole} "${name}"`,
        textFingerprint: name.toLowerCase(),
      });
    }

    const valueStr = value
      ? ` value=${JSON.stringify(safeTerminalText(secure ? "[REDACTED]" : value))}`
      : "";
    const disabled = node.properties?.slice(0, 1000)
      .find((property) => property.name === "disabled")?.value?.value
      ? " [disabled]"
      : "";
    const line = `${safeRole} ${JSON.stringify(name)}${ref}${valueStr}${disabled}`;
    if (
      snapshotLines.length >= MAX_SNAPSHOT_LINES
      || snapshotChars + line.length > MAX_SNAPSHOT_CHARS
    ) {
      snapshotLines.push("[snapshot truncated]");
      break;
    }
    snapshotLines.push(line);
    snapshotChars += line.length + 1;
  }
  let title = "";
  try {
    const parsed = runtimeStringResultSchema.safeParse(
      await cdp.Runtime.evaluate({ expression: "document.title", returnByValue: true }),
    );
    if (parsed.success) title = sanitizeBrowserTitle(parsed.data.result.value);
  } catch {}

  try {
    const parsed = runtimeStringResultSchema.safeParse(
      await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true }),
    );
    if (parsed.success) session.url = parsed.data.result.value;
  } catch {}

  const header = `[${title || "Untitled"}] ${sanitizeBrowserUrl(session.url)}\n\n`;
  const body = snapshotLines.join("\n") || "(no interactive elements found)";
  const hint = `\n\n--- ${session.refMap.size} interactive elements, refs e1..e${session.lastRefCounter} ---`;
  return header + body + hint;
}

/**
 * Project Chrome's accessibility snapshot into the normalized provider
 * records consumed by the host UI tools.
 */
const uiProjectionInFlight = new WeakMap<BrowserSession, Promise<PluginUiElement[]>>();

export function buildUiElements(
  session: BrowserSession,
  cdp: CDPClientInterface,
): Promise<PluginUiElement[]> {
  const current = uiProjectionInFlight.get(session);
  if (current) return current;

  const work = new ProjectionWork();
  let projection!: Promise<PluginUiElement[]>;
  projection = buildUiElementsOnce(session, cdp, work).then(
    (result) => {
      clearProjectionGuard(uiProjectionInFlight, session, projection, work);
      return result;
    },
    (error: unknown) => {
      clearProjectionGuard(uiProjectionInFlight, session, projection, work);
      throw error;
    },
  );
  uiProjectionInFlight.set(session, projection);
  return projection;
}

async function buildUiElementsOnce(
  _session: BrowserSession,
  cdp: CDPClientInterface,
  work: ProjectionWork,
): Promise<PluginUiElement[]> {
  let axNodes: CDPAccessibilityNode[];
  try {
    const result = await cdp.Accessibility.getFullAXTree();
    axNodes = result.nodes ?? [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get browser accessibility tree: ${message}`);
  }

  const nodeLimit = Math.min(axNodes.length, MAX_AX_NODES);
  const candidates: DomProbeCandidate[] = [];
  const candidateByKey = new Map<number, DomProbeCandidate>();
  for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex++) {
    const node = axNodes[nodeIndex];
    if (node.ignored) continue;
    const role = formatValue(node.role) ?? "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;

    const rawName = formatValue(node.name) ?? "";
    const value = formatValue(node.value);
    const accessibilitySecure = isSecureAccessibilityNode(node);
    const securityProbe = securityProbeRequired(
      node,
      role.toLowerCase(),
      rawName,
      value,
      accessibilitySecure,
    );
    const needsGeometry = Object.hasOwn(INTERACTIVE_ROLES, role)
      || Object.hasOwn(SCROLLABLE_ROLES, role)
      || propertyValue(node, "focusable") === true;
    const needsSecurity = securityProbe;
    if (!needsSecurity && !needsGeometry) continue;

    const candidate: DomProbeCandidate = {
      key: nodeIndex,
      node,
      accessibilitySecure,
      needsSecurity,
      needsGeometry,
      needsNodeId: true,
      needsMetadata: needsSecurity || needsGeometry,
    };
    candidates.push(candidate);
    candidateByKey.set(nodeIndex, candidate);
  }

  const budget = createProjectionBudget();
  const details = await resolveDomDetailsBatch(cdp, candidates, budget, work);
  const elements: PluginUiElement[] = [];
  let totalStringChars = 0;
  const readUiString = (value: string | undefined, field: string): string => {
    const text = value ?? "";
    if (text.length > MAX_BROWSER_UI_STRING_CHARS) {
      throw new Error(
        `Browser accessibility ${field} exceeded the ${MAX_BROWSER_UI_STRING_CHARS}-character limit.`,
      );
    }
    totalStringChars += text.length;
    if (totalStringChars > MAX_BROWSER_UI_TOTAL_STRING_CHARS) {
      throw new Error(
        `Browser accessibility tree exceeded the ${MAX_BROWSER_UI_TOTAL_STRING_CHARS}-character text limit.`,
      );
    }
    return safeTerminalText(text);
  };

  for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex++) {
    const node = axNodes[nodeIndex];
    if (node.ignored) continue;
    const role = formatValue(node.role) ?? "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;

    const rawName = formatValue(node.name) ?? "";
    const value = formatValue(node.value);
    const accessibilitySecure = isSecureAccessibilityNode(node);
    const candidate = candidateByKey.get(nodeIndex);
    const domDetails = candidate
      ? details.get(nodeIndex) ?? defaultDomNodeDetails(candidate)
      : {
          secure: accessibilitySecure,
          textEntry: false,
          securityClassificationComplete: true,
          geometryComplete: true,
        };
    const securityIncomplete = Boolean(
      candidate?.needsMetadata && !domDetails.securityClassificationComplete,
    );
    const textEntry = isTextEntryRole(role) || domDetails.textEntry === true;
    const secure = accessibilitySecure
      || hasValueBearingTextInput(role, value)
      || domDetails.secure
      || securityIncomplete;
    const geometryIncomplete = Boolean(
      candidate?.needsGeometry && !domDetails.geometryComplete,
    );
    const nonActionable = securityIncomplete || geometryIncomplete;
    const safeRole = readUiString(role, "role");
    const safeName = readUiString(secure ? "[REDACTED]" : rawName, "name");
    const safeValue = secure || value === undefined
      ? undefined
      : readUiString(value, "value");
    const safeText = safeValue ?? safeName;
    const safeIdValue = domDetails.id
      ? (secure || textEntry ? "[REDACTED]" : domDetails.id)
      : undefined;
    const safeId = safeIdValue
      ? readUiString(safeIdValue, "id")
      : undefined;
    const disabled = propertyValue(node, "disabled") === true;
    const focused = propertyValue(node, "focused") === true;
    const hidden = propertyValue(node, "hidden") === true;
    const checkedValue = propertyValue(node, "checked");
    const checked = checkedValue === true || checkedValue === "mixed";
    const interactive = Object.hasOwn(INTERACTIVE_ROLES, role);
    const clickable = interactive && !nonActionable;
    const checkable = role === "checkbox" || role === "radio" || role === "switch";
    const bounds = domDetails.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const record: PluginUiElement = {
      index: elements.length,
      ...(safeId ? { id: safeId } : {}),
      role: safeRole,
      className: safeRole,
      packageName: "browser",
      text: safeText,
      label: safeName,
      contentDesc: safeName,
      ...(safeValue !== undefined ? { value: safeValue } : {}),
      enabled: !disabled && !nonActionable,
      visible: !hidden && !nonActionable,
      checkable,
      checked,
      clickable,
      focusable: !nonActionable
        && (propertyValue(node, "focusable") === true || interactive),
      focused: focused && !nonActionable,
      scrollable: Object.hasOwn(SCROLLABLE_ROLES, role),
      password: secure,
      bounds,
      centerX: bounds.x + bounds.width / 2,
      centerY: bounds.y + bounds.height / 2,
    };
    elements.push(record);
  }
  return elements;
}
