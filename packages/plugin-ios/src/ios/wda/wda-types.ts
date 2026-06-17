export interface WDASession {
  sessionId: string;
  capabilities: Record<string, any>;
}

export interface WDAElement {
  ELEMENT: string;
  "element-6066-11e4-a52e-4f735466cecf"?: string;
}

export interface WDARect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UITreeNode {
  type: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  rect?: WDARect;
  children?: UITreeNode[];
}

export type LocatorStrategy =
  | "name"
  | "accessibility id"
  | "class name"
  | "xpath"
  | "predicate string";

export interface TouchAction {
  action: "tap" | "press" | "moveTo" | "wait" | "release";
  options?: {
    x?: number;
    y?: number;
    element?: string;
    ms?: number;
  };
}

export interface WDAInstanceInfo {
  pid: number;
  port: number;
  deviceId: string;
}
