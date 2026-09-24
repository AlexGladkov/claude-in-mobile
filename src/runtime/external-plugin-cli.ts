import { resolveExternalPlugins, writeExternalPlugins } from "./external-plugin-config.js";
import { ExternalPluginManager } from "./external-plugin-manager.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

function printExternalList(
  manager: ExternalPluginManager,
): Promise<void> {
  return manager.list().then((plugins) => {
    console.log(`External plugins: ${plugins.length}`);
    if (plugins.length === 0) {
      console.log("  none");
      return;
    }
    for (const plugin of plugins) {
      const permissions = plugin.permissions.length > 0
        ? plugin.permissions.join(", ")
        : "none";
      const granted = plugin.grantedPermissions.length > 0
        ? plugin.grantedPermissions.join(", ")
        : "none";
      console.log(`  ${plugin.id} ${plugin.packageName}@${plugin.packageVersion}`);
      console.log(`    plugin version: ${plugin.pluginVersion}; api: ${plugin.apiVersion}`);
      console.log(`    permissions: ${permissions}`);
      console.log(`    granted: ${granted}`);
      console.log(`    integrity: ${plugin.integrity}`);
    }
  });
}

function parseInstallArgs(args: readonly string[]): { spec: string; replace: boolean } {
  let replace = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--replace") replace = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown plugin install option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error("Usage: mcp-devices plugin install <package|path> [--replace]");
  }
  return { spec: positional[0]!, replace };
}

async function runExternalAction(
  action: string,
  args: readonly string[],
): Promise<number> {
  const manager = new ExternalPluginManager();
  switch (action) {
    case "list":
      await printExternalList(manager);
      return 0;
    case "install": {
      const { spec, replace } = parseInstallArgs(args);
      const entry = await manager.install(spec, { replace });
      console.log(`Installed external plugin '${entry.id}' from ${entry.packageName}@${entry.packageVersion}.`);
      if (entry.permissions.length > 0) {
        console.log(`Grant permissions explicitly with: mcp-devices plugin grant ${entry.id} ${entry.permissions.join(" ")}`);
      }
      console.log("Enable loading with: mcp-devices plugin external enable");
      return 0;
    }
    case "update": {
      const updated = await manager.update(args);
      for (const entry of updated) {
        console.log(`Updated ${entry.id} to ${entry.packageName}@${entry.packageVersion}.`);
      }
      if (updated.length === 0) console.log("No external plugins are installed.");
      return 0;
    }
    case "remove": {
      if (args.length === 0) throw new Error("Usage: mcp-devices plugin remove <plugin-id>...");
      for (const id of args) {
        await manager.remove(id);
        console.log(`Removed external plugin '${id}'.`);
      }
      return 0;
    }
    case "verify": {
      const results = await manager.verify(args);
      let failed = false;
      for (const result of results) {
        console.log(`${result.ok ? "OK" : "FAIL"} ${result.id}${result.reason ? ` — ${result.reason}` : ""}`);
        failed ||= !result.ok;
      }
      if (results.length === 0) console.log("No external plugins are installed.");
      return failed ? 1 : 0;
    }
    case "grant": {
      const [id, ...permissions] = args;
      if (!id || permissions.length === 0) {
        throw new Error("Usage: mcp-devices plugin grant <plugin-id> <permission>...");
      }
      const granted = await manager.grant(id, permissions);
      console.log(`Granted ${id}: ${granted.join(", ")}`);
      return 0;
    }
    case "revoke": {
      const [id, ...permissions] = args;
      if (!id) throw new Error("Usage: mcp-devices plugin revoke <plugin-id> [permission]...");
      const remaining = await manager.revoke(id, permissions);
      console.log(`Granted ${id}: ${remaining.join(", ") || "none"}`);
      return 0;
    }
    default:
      throw new Error(
        "Usage: mcp-devices plugin external <list|enable|disable|status> | "
        + "plugin <install|update|remove|verify|grant|revoke>",
      );
  }
}

export async function runExternalPluginCommand(
  argv: readonly string[],
  exit: (code: number) => never = process.exit,
): Promise<boolean> {
  if (argv[2] !== "plugin") return false;
  const action = argv[3];
  if (
    action !== "external"
    && action !== "install"
    && action !== "update"
    && action !== "remove"
    && action !== "verify"
    && action !== "grant"
    && action !== "revoke"
  ) {
    return false;
  }

  try {
    if (action === "external") {
      const subcommand = argv[4] ?? "status";
      if (subcommand === "enable" || subcommand === "disable") {
        if (argv.length > 5) throw new Error("Usage: mcp-devices plugin external <enable|disable>");
        writeExternalPlugins(subcommand === "enable");
        console.log(`External plugin loading ${subcommand}d.`);
        return exit(0);
      }
      if (subcommand === "status" || subcommand === "list") {
        if (argv.length > 5) throw new Error("Usage: mcp-devices plugin external <status|list>");
        console.log(`External plugin loading: ${resolveExternalPlugins() ? "enabled" : "disabled"}`);
        if (subcommand === "list") await printExternalList(new ExternalPluginManager());
        return exit(0);
      }
      throw new Error("Usage: mcp-devices plugin external <list|enable|disable|status>");
    }

    const status = await runExternalAction(action, argv.slice(4));
    return exit(status);
  } catch (error: unknown) {
    console.error(sanitizeErrorMessage(error instanceof Error ? error.message : String(error)));
    return exit(1);
  }
}