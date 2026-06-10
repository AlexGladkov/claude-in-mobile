import { MobileError } from "./base.js";

export class ElementNotFoundError extends MobileError {
  constructor(criteria: string) {
    super(
      `Element not found: ${criteria}. Use ui(action:'tree') or ui(action:'analyze') to see available elements.`,
      "ELEMENT_NOT_FOUND"
    );
  }
}

export class WebViewNotFoundError extends MobileError {
  constructor() {
    super(
      "No WebView found in the current app. Make sure the app has an active WebView with debugging enabled.",
      "WEBVIEW_NOT_FOUND"
    );
  }
}

export class BrowserSecurityError extends MobileError {
  constructor(url: string, protocol: string) {
    super(
      `Blocked URL "${url}". Protocol "${protocol}" is not allowed. Use http:// or https://.`,
      "BROWSER_SECURITY"
    );
  }
}

export class BrowserSessionNotFoundError extends MobileError {
  constructor(session: string, active: string[]) {
    super(
      `Browser session "${session}" not found.${active.length > 0 ? ` Active sessions: ${active.join(", ")}.` : ""} Use browser(action:'open') to start a session.`,
      "BROWSER_SESSION_NOT_FOUND"
    );
  }
}

export class BrowserNoSessionError extends MobileError {
  constructor() {
    super(
      "No active browser session. Call browser(action:'open', url:...) to start.",
      "BROWSER_NO_SESSION"
    );
  }
}

export class BrowserRefNotFoundError extends MobileError {
  constructor(ref: string, lastKnown?: string) {
    super(
      `Ref "${ref}" is stale or not found${lastKnown ? ` (was: ${lastKnown})` : ""}. Call browser(action:'snapshot') to get fresh refs.`,
      "BROWSER_REF_NOT_FOUND"
    );
  }
}

export class ChromeNotInstalledError extends MobileError {
  constructor() {
    super(
      "Chrome/Chromium not found. Install Google Chrome: https://google.com/chrome or set CHROME_PATH environment variable.",
      "CHROME_NOT_INSTALLED"
    );
  }
}
