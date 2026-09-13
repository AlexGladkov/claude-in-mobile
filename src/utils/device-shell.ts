export function quotePosixArg(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildDeviceShellCommand(args: readonly string[]): string {
  if (args.length === 0) throw new Error("Device shell command must not be empty.");
  return args.map(quotePosixArg).join(" ");
}
