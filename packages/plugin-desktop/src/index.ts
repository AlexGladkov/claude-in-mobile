/**
 * `@claude-in-mobile/plugin-desktop` — thin npm shim around the Desktop
 * (Compose) plugin shipped inside the main `claude-in-mobile` package.
 */

import {
  createDesktopPlugin,
  DesktopPlugin,
  DESKTOP_PLUGIN_MANIFEST,
} from "claude-in-mobile/plugins/desktop";

export { DesktopPlugin, DESKTOP_PLUGIN_MANIFEST };
export const createPlugin = createDesktopPlugin;
export default createDesktopPlugin;
