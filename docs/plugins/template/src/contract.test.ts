// Place this next to src/plugins/<your-id>/index.ts so the generic suite
// validates the lifecycle and manifest invariants.
import { runPluginContract } from "../../../../src/plugins/contract-suite.js";
import { createTemplatePlugin } from "./index.js";

runPluginContract(createTemplatePlugin);
