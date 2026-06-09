import { ValidationError } from "../../errors.js";

export function validateNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new ValidationError(`${label} must be a valid number, got: ${String(value)}`);
  }
  return n;
}

export function validateLatitude(lat: number): void {
  if (lat < -90 || lat > 90) {
    throw new ValidationError(`latitude must be between -90 and 90, got: ${lat}`);
  }
}

export function validateLongitude(lon: number): void {
  if (lon < -180 || lon > 180) {
    throw new ValidationError(`longitude must be between -180 and 180, got: ${lon}`);
  }
}

export function validateBatteryLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > 100) {
    throw new ValidationError(`battery level must be an integer 0–100, got: ${level}`);
  }
}

/** Map plugged string to the dumpsys set commands. */
export function pluggedCommands(plugged: string): string[] {
  const cmds: string[] = [
    "dumpsys battery set ac 0",
    "dumpsys battery set usb 0",
    "dumpsys battery set wireless 0",
  ];
  if (plugged === "ac") cmds[0] = "dumpsys battery set ac 1";
  else if (plugged === "usb") cmds[1] = "dumpsys battery set usb 1";
  else if (plugged === "wireless") cmds[2] = "dumpsys battery set wireless 1";
  return cmds;
}
