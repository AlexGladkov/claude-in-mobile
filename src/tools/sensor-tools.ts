/**
 * Sensor tools facade.
 *
 * The implementation lives in `./sensor/`:
 *   - constants.ts            — BATTERY_STATUS_CODES / THERMAL_STATUS_CODES lookup tables
 *   - helpers.ts              — input validators & dumpsys command builders
 *   - notifications-parser.ts — `dumpsys notification` parser
 *   - location.ts             — sensor_location tool
 *   - battery.ts              — sensor_battery tool
 *   - notifications.ts        — sensor_notifications tool
 *   - thermal.ts              — sensor_thermal tool
 *   - tools.ts                — `sensorTools` array
 */

export { sensorTools } from "./sensor/index.js";
