import type { CDPClientInterface } from "./cdp-types.js";

/** Minimal interface for chrome-launcher's LaunchedChrome */
export interface LaunchedChrome {
  port: number;
  process: { pid?: number };
  kill(): Promise<void>;
}

export interface BrowserSession {
  id: string;
  chrome: LaunchedChrome;
  cdp: CDPClientInterface;
  port: number;
  profileDir: string;
  refMap: Map<string, RefEntry>;
  lastRefCounter: number;
  url: string;
  staleRefMap?: Map<string, RefEntry>;
}

export interface RefEntry {
  selector: string;
  backendNodeId: number;
  label: string; // aria label / text for stale ref error
  textFingerprint?: string; // lowercased text for fallback search
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

// S2: Browser navigation uses an ALLOWLIST (not a denylist). Only http/https
// reach CDP Page.navigate. A denylist let data:, blob:, javascript:, ftp: etc.
// through; an allowlist is fail-closed and mirrors validateUrl in
// src/utils/sanitize.ts. (market:/tel:/mailto: are valid for system_open_url
// but never for a headless browser navigation, so they stay out here.)
export const ALLOWED_URL_PROTOCOLS = new Set([
  "http:",
  "https:",
]);

export const DEFAULT_SESSION = "default";
