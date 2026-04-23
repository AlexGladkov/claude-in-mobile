/**
 * Type definitions for Chrome DevTools Protocol communication.
 *
 * Covers the subset of CDP used by BrowserClient. These types replace
 * raw `any` in method signatures and local variables, providing compile-time
 * safety for CDP interactions.
 */

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CDPNode {
  nodeId: number;
  nodeName: string;
  nodeType: number;
  nodeValue?: string;
  childNodeCount?: number;
  children?: CDPNode[];
  attributes?: string[];
  localName?: string;
}

export interface CDPEvaluateResult {
  result: {
    type: string;
    value?: unknown;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export interface CDPBoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

export interface CDPAccessibilityValue {
  type: string;
  value?: string;
}

export interface CDPAccessibilityProperty {
  name: string;
  value: { value: unknown };
}

export interface CDPAccessibilityNode {
  nodeId: string;
  ignored?: boolean;
  role?: CDPAccessibilityValue;
  name?: CDPAccessibilityValue;
  value?: CDPAccessibilityValue;
  properties?: CDPAccessibilityProperty[];
  backendDOMNodeId?: number;
}

/**
 * CDP client interface representing the subset of methods used by BrowserClient.
 * Using this instead of `any` for CDP sessions.
 */
export interface CDPClientInterface {
  Page: {
    enable(): Promise<void>;
    navigate(params: { url: string }): Promise<unknown>;
    loadEventFired(callback: () => void): void;
    frameNavigated(callback: () => void): void;
    reload(): Promise<void>;
    captureScreenshot(params: { format: string; captureBeyondViewport?: boolean }): Promise<{ data: string }>;
  };
  Runtime: {
    enable(): Promise<void>;
    evaluate(params: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }): Promise<CDPEvaluateResult>;
    callFunctionOn(params: { objectId: string; functionDeclaration: string; returnByValue?: boolean }): Promise<CDPEvaluateResult>;
  };
  DOM: {
    enable(): Promise<void>;
    getDocument(params: { depth: number }): Promise<{ root: { nodeId: number } }>;
    querySelector(params: { nodeId: number; selector: string }): Promise<{ nodeId: number }>;
    resolveNode(params: { nodeId: number }): Promise<{ object: { objectId: string } }>;
    pushNodesByBackendIdsToFrontend(params: { backendNodeIds: number[] }): Promise<{ nodeIds: number[] }>;
    getBoxModel(params: { nodeId: number }): Promise<{ model: CDPBoxModel }>;
    focus(params: { nodeId: number }): Promise<void>;
  };
  Network: {
    enable(): Promise<void>;
  };
  Accessibility: {
    getFullAXTree(): Promise<{ nodes: CDPAccessibilityNode[] }>;
  };
  Input: {
    dispatchMouseEvent(params: {
      type: string;
      x: number;
      y: number;
      button?: string;
      clickCount?: number;
    }): Promise<void>;
    dispatchKeyEvent(params: {
      type: string;
      key: string;
      code: string;
      windowsVirtualKeyCode: number;
      nativeVirtualKeyCode?: number;
      modifiers?: number;
      text?: string;
    }): Promise<void>;
    insertText(params: { text: string }): Promise<void>;
  };
  close(): Promise<void>;
}
