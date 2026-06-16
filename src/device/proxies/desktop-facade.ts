/**
 * DesktopFacade — encapsulates desktop adapter lifecycle and browser
 * adapter accessor. Extracted from DeviceManager (D9.1c) to keep the
 * orchestrator under 400 LOC.
 *
 * Behaviour-preserving: errors, side effects (activeTarget mutation is
 * still owned by DeviceManager — launchDesktopApp returns success so
 * the caller can flip the target), and message text match the legacy
 * implementation byte-for-byte.
 */

import type { CorePlatformAdapter } from "../../adapters/platform-adapter.js";
import { DesktopAdapter } from "../../adapters/desktop-adapter.js";
import { IosAdapter } from "../../adapters/ios-adapter.js";
import type { BrowserAdapterLike } from "../../adapters/contracts.js";
import { DesktopClient } from "../../desktop/client.js";
import type { RawLaunchOptions } from "../../desktop/types.js";
import type { Platform } from "../../platform-types.js";
import type { WebViewInspector } from "../../adb/webview.js";

export class DesktopFacade {
  constructor(private readonly adapters: Map<Platform, CorePlatformAdapter>) {}

  private requireDesktop(): DesktopAdapter {
    const desktop = this.adapters.get("desktop");
    if (!desktop || !(desktop instanceof DesktopAdapter)) {
      throw new Error("Desktop adapter is not available in this configuration.");
    }
    return desktop;
  }

  /**
   * Launches the desktop companion / app. Returns the human-readable
   * success message previously produced inline in DeviceManager.
   * Caller is responsible for flipping `activeTarget` to "desktop".
   */
  async launch(options: RawLaunchOptions): Promise<string> {
    const desktop = this.requireDesktop();
    await desktop.launch(options);
    if (options.mode === "bundle") {
      const target = options.bundleId ?? options.appPath ?? "app";
      return `Desktop automation started. App launched: ${target}`;
    }
    if (options.mode === "attach" && options.pid !== undefined) {
      return `Desktop automation started. Attached to process PID ${options.pid}`;
    }
    if (options.projectPath) {
      return `Desktop automation started. Also launching app from ${options.projectPath}`;
    }
    return "Desktop automation started (companion only)";
  }

  async stop(): Promise<void> {
    await this.requireDesktop().stop();
  }

  getClient(): DesktopClient {
    return this.requireDesktop().getClient();
  }

  isRunning(): boolean {
    const adapter = this.adapters.get("desktop");
    if (!adapter || !(adapter instanceof DesktopAdapter)) return false;
    return adapter.isRunning();
  }

  getState(): { status: string } | undefined {
    const adapter = this.adapters.get("desktop");
    if (adapter instanceof DesktopAdapter) return adapter.getState();
    return undefined;
  }

  getBrowser(): BrowserAdapterLike {
    const adapter = this.adapters.get("browser");
    if (!adapter) {
      throw new Error(
        "Web is not installed. Run `claude-in-mobile install web`."
      );
    }
    return adapter as unknown as BrowserAdapterLike;
  }

  /**
   * Best-effort cleanup of long-lived resources owned by desktop, ios,
   * browser adapters + an optional WebViewInspector. Mirrors the legacy
   * try/catch swallow semantics so a single broken adapter cannot
   * prevent the others from being torn down.
   */
  async cleanup(webViewInspector?: WebViewInspector): Promise<void> {
    const desktop = this.adapters.get("desktop");
    if (desktop instanceof DesktopAdapter) {
      try { await desktop.stop(); } catch {}
    }
    const ios = this.adapters.get("ios");
    if (ios instanceof IosAdapter) {
      try { ios.getClient().cleanup(); } catch {}
    }
    try { webViewInspector?.cleanup(); } catch {}
    const browser = this.adapters.get("browser") as
      | { cleanup?: () => Promise<void> }
      | undefined;
    if (browser && typeof browser.cleanup === "function") {
      try { await browser.cleanup(); } catch {}
    }
  }
}
