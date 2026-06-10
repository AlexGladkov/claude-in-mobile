import type { ToolDefinition } from "./registry.js";
import { flowBatch } from "./flow/batch.js";
import { flowRun } from "./flow/run.js";
import { flowParallel } from "./flow/parallel.js";

export const flowTools: ToolDefinition[] = [flowBatch, flowRun, flowParallel];
