export type ClientType = "claude-code" | "opencode" | "cursor" | "unknown";

export interface AliasWithDefaults {
  tool: string;
  defaults: Record<string, unknown>;
}

export interface ClientAdapter {
  clientType: ClientType;
  clientName: string;
  clientVersion: string;
  getAdditionalAliases(): Record<string, string>;
  getAliasesWithDefaults(): Record<string, AliasWithDefaults>;
  getInstructions(): string;
}

interface ClientInfo {
  name: string;
  version: string;
}

const CLIENT_MATCHERS: Array<{ pattern: RegExp; type: ClientType }> = [
  { pattern: /claude/i, type: "claude-code" },
  { pattern: /opencode/i, type: "opencode" },
  { pattern: /cursor/i, type: "cursor" },
];

const OPENCODE_ALIASES: Record<string, string> = {
  touch: "input_tap",
  press: "input_tap",
  capture_screen: "screen_capture",
};

const OPENCODE_ALIASES_WITH_DEFAULTS: Record<string, AliasWithDefaults> = {
  swipe_up: { tool: "input_swipe", defaults: { direction: "up" } },
  swipe_down: { tool: "input_swipe", defaults: { direction: "down" } },
};

const INSTRUCTIONS: Record<ClientType, string> = {
  "claude-code":
    "Mobile/desktop automation. Use 'screen' for screenshots, 'input' for taps/swipes/text, 'ui' for accessibility tree. device(action:'enable_module', module:'browser') to load browser/desktop/store tools.",
  opencode:
    "Mobile/desktop automation. Use 'screen' for screenshots, 'input' for taps/swipes/text, 'ui' for accessibility tree. device(action:'list') for devices, device(action:'enable_module', module:'browser') to load optional modules.",
  cursor:
    "Mobile/desktop automation. Use 'screen' for screenshots, 'input' for taps/swipes/text, 'ui' for accessibility tree. device(action:'enable_module', module:'browser') to load browser/desktop/store tools.",
  unknown:
    "Mobile/desktop automation. Use 'screen' for screenshots, 'input' for taps/swipes/text, 'ui' for accessibility tree. device(action:'list') for devices.",
};

export function detectClient(clientInfo: ClientInfo | undefined): ClientAdapter {
  if (!clientInfo) {
    return createAdapter("unknown", "unknown", "unknown");
  }

  const matched = CLIENT_MATCHERS.find((m) => m.pattern.test(clientInfo.name));
  const clientType = matched?.type ?? "unknown";

  return createAdapter(clientType, clientInfo.name, clientInfo.version);
}

function createAdapter(
  clientType: ClientType,
  clientName: string,
  clientVersion: string,
): ClientAdapter {
  return {
    clientType,
    clientName,
    clientVersion,

    getAdditionalAliases(): Record<string, string> {
      if (clientType === "opencode") return { ...OPENCODE_ALIASES };
      return {};
    },

    getAliasesWithDefaults(): Record<string, AliasWithDefaults> {
      if (clientType === "opencode") return { ...OPENCODE_ALIASES_WITH_DEFAULTS };
      return {};
    },

    getInstructions(): string {
      return INSTRUCTIONS[clientType];
    },
  };
}

// ── Config snippet generation ──

const CONFIG_TEMPLATES: Record<string, object> = {
  opencode: {
    mcp: {
      mobile: {
        type: "local",
        command: ["npx", "-y", "claude-in-mobile"],
        enabled: true,
      },
    },
  },
  cursor: {
    mcpServers: {
      mobile: {
        command: "npx",
        args: ["-y", "claude-in-mobile"],
      },
    },
  },
  "claude-code": {
    mcpServers: {
      mobile: {
        command: "npx",
        args: ["-y", "claude-in-mobile"],
      },
    },
  },
};

export function getConfigSnippet(client: ClientType): string {
  const template = CONFIG_TEMPLATES[client];
  if (!template) {
    throw new Error(
      `Unsupported client: ${client}. Supported: ${Object.keys(CONFIG_TEMPLATES).join(", ")}`,
    );
  }
  return JSON.stringify(template, null, 2);
}
