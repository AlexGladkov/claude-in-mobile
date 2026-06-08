/**
 * `@claude-in-mobile/plugin-ios` — thin npm shim around the iOS plugin
 * shipped inside the main `claude-in-mobile` package.
 */

import {
  createIosPlugin,
  IosPlugin,
  IOS_PLUGIN_MANIFEST,
} from "claude-in-mobile/plugins/ios";

export { IosPlugin, IOS_PLUGIN_MANIFEST };
export const createPlugin = createIosPlugin;
export default createIosPlugin;
