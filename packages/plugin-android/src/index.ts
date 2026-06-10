/**
 * `@claude-in-mobile/plugin-android` — thin npm shim around the Android
 * plugin shipped inside the main `claude-in-mobile` package. The actual
 * implementation lives at `claude-in-mobile/plugins/android` for now;
 * publishing a separate shim establishes the topology so third-party
 * consumers can pin a specific platform plugin today, and so the 4.0.0
 * source-move is a one-step relocation instead of a topology change.
 */

import {
  createAndroidPlugin,
  AndroidPlugin,
  ANDROID_PLUGIN_MANIFEST,
} from "claude-in-mobile/plugins/android";

export { AndroidPlugin, ANDROID_PLUGIN_MANIFEST };
export const createPlugin = createAndroidPlugin;
export default createAndroidPlugin;
