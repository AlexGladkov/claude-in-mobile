/**
 * `@claude-in-mobile/plugin-aurora` — thin npm shim around the Aurora OS
 * plugin shipped inside the main `claude-in-mobile` package.
 */

import {
  createAuroraPlugin,
  AuroraPlugin,
  AURORA_PLUGIN_MANIFEST,
} from "claude-in-mobile/plugins/aurora";

export { AuroraPlugin, AURORA_PLUGIN_MANIFEST };
export const createPlugin = createAuroraPlugin;
export default createAuroraPlugin;
