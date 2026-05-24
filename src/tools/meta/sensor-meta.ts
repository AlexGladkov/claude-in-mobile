import { createMetaTool } from "./create-meta-tool.js";
import { sensorTools } from "../sensor-tools.js";

const { meta, aliases } = createMetaTool({
  name: "sensor",
  description:
    "Sensor & Environment Simulation. location: set GPS coordinates. battery: set battery level/status. notifications: read notification shade. thermal: set thermal status.",
  tools: sensorTools,
  prefix: "sensor_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios"],
      description: "Target platform. If not specified, uses the active target.",
    },
    latitude: {
      type: "number",
      description: "Latitude in decimal degrees (-90 to 90) (location)",
    },
    longitude: {
      type: "number",
      description: "Longitude in decimal degrees (-180 to 180) (location)",
    },
    altitude: {
      type: "number",
      description: "Altitude in meters, default 0 (location)",
    },
    level: {
      type: "number",
      description: "Battery level 0-100 (battery)",
    },
    status: {
      type: "string",
      description: "Battery status: charging|discharging|not-charging|full (battery). Thermal status: none|light|moderate|severe|critical|emergency|shutdown (thermal).",
    },
    plugged: {
      type: "string",
      description: "Power source: ac|usb|wireless|none (battery)",
    },
    reset: {
      type: "boolean",
      description: "Reset battery or thermal override back to real hardware state (battery, thermal)",
    },
    package: {
      type: "string",
      description: "Filter notifications by package name, e.g. com.example.app (notifications)",
    },
  },
});

export const sensorMeta = meta;
export const sensorAliases = aliases;
