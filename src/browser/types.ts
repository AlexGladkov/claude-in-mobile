export interface BrowserSession {
  id: string;
  chrome: any; // LaunchedChrome from chrome-launcher
  cdp: any;    // chrome-remote-interface client
  port: number;
  profileDir: string;
  refMap: Map<string, RefEntry>;
  lastRefCounter: number;
  url: string;
}

export interface RefEntry {
  selector: string;
  backendNodeId: number;
  label: string; // aria label / text for stale ref error
}

export interface BrowserOpenOptions {
  url: string;
  session?: string;
  headless?: boolean;
}

export interface BrowserNavigateOptions {
  url?: string;
  action?: "back" | "forward" | "reload";
  session?: string;
}

export interface BrowserClickOptions {
  ref?: string;
  selector?: string;
  text?: string;
  session?: string;
}

export interface BrowserFillOptions {
  ref?: string;
  selector?: string;
  value: string;
  session?: string;
  clear?: boolean;
  pressEnter?: boolean;
}

export interface BrowserFillFormField {
  ref?: string;
  selector?: string;
  value: string;
}

export interface BrowserFillFormOptions {
  fields: BrowserFillFormField[];
  submit?: boolean;
  session?: string;
}

export interface BrowserSnapshotNode {
  role: string;
  name: string;
  ref?: string;
  children?: BrowserSnapshotNode[];
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
}

export const BLOCKED_URL_PROTOCOLS = new Set([
  "file:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "view-source:",
]);

export const DEFAULT_SESSION = "default";
