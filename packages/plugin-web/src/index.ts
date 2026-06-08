/**
 * `@claude-in-mobile/plugin-web` — thin npm shim around the Web (CDP)
 * plugin shipped inside the main `claude-in-mobile` package.
 */

import {
  createWebPlugin,
  WebPlugin,
  WEB_PLUGIN_MANIFEST,
} from "claude-in-mobile/plugins/web";

export { WebPlugin, WEB_PLUGIN_MANIFEST };
export const createPlugin = createWebPlugin;
export default createWebPlugin;
