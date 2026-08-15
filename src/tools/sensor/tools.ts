import type { ToolDefinition } from "../registry.js";
import { sensorLocationTool } from "./location.js";
import { sensorBatteryTool } from "./battery.js";
import { sensorNotificationsTool } from "./notifications.js";
import { sensorThermalTool } from "./thermal.js";
import { auroraSensorCapabilityTools } from "../aurora-capability-tools.js";

export const sensorTools: ToolDefinition[] = [
  sensorLocationTool,
  sensorBatteryTool,
  sensorNotificationsTool,
  sensorThermalTool,
  ...auroraSensorCapabilityTools,
];
