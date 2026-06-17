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
import type {
  BrowserAdapterLike,
  DesktopAdapterLike,
  DesktopClientLike,
  RawLaunchOptionsLike,
  WebViewInspectorLike,
} from "../../adapters/contracts.js";
import type { Platform } from "../../platform-types.js";

export class DesktopFacade {
  constructor(private readonly adapters: Map<Platform, CorePlatformAdapter>) {}

  private requireDesktop(): DesktopAdapterLike {
    const desktop = this.adapters.get("desktop") as DesktopAdapterLike | undefined;
    if (!desktop || typeof desktop.launch !== "function") {
      throw new Error(
        "Desktop is not installed. Run `claude-in-mobile install desktop`."
      );
    }
    return desktop;
  }

  /**
   * Launches the desktop companion / app. Returns the human-readable
   * success message previously produced inline in DeviceManager.
   * Caller is responsible for flipping `activeTarget` to "desktop".
   */
  async launch(options: RawLaunchOptionsLike): Promise<string> {
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

  getClient(): DesktopClientLike {
    return this.requireDesktop().getClient();
  }

  isRunning(): boolean {
    const adapter = this.adapters.get("desktop") as DesktopAdapterLike | undefined;
    if (!adapter || typeof adapter.isRunning !== "function") return false;
    return Boolean(adapter.isRunning());
  }

  getState(): { status: string } | undefined {
    const adapter = this.adapters.get("desktop") as DesktopAdapterLike | undefined;
    if (adapter && typeof adapter.getState === "function") {
      return adapter.getState() as { status: string } | undefined;
    }
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
  async cleanup(webViewInspector?: WebViewInspectorLike): Promise<void> {
    const desktop = this.adapters.get("desktop") as
      | { stop?: () => Promise<void> }
      | undefined;
    if (desktop && typeof desktop.stop === "function") {
      try { await desktop.stop(); } catch {}
    }
    const ios = this.adapters.get("ios") as { getClient?: () => { cleanup?: () => void } } | undefined;
    if (ios && typeof ios.getClient === "function") {
      try { ios.getClient().cleanup?.(); } catch {}
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
