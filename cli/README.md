# mobile-tools CLI

Fast native Rust CLI alternative to the MCP server. Implements all the same automation commands as `claude-in-mobile` but as a standalone binary — no Node.js required, instant startup.

## Install

### From source (requires Rust)

```bash
cd cli
cargo build --release
cp target/release/mobile-tools /usr/local/bin/
```

### From release binary

Download the pre-built binary for your platform from [Releases](https://github.com/AlexGladkov/claude-in-mobile/releases) and place it in your PATH:

```bash
# macOS ARM64 (Apple Silicon)
tar -xzf mobile-tools-2.8.0-darwin-arm64.tar.gz
cp mobile-tools /usr/local/bin/

# macOS x86_64 (Intel)
tar -xzf mobile-tools-2.8.0-darwin-x86_64.tar.gz
cp mobile-tools /usr/local/bin/

# Linux x86_64
tar -xzf mobile-tools-2.8.0-linux-x86_64.tar.gz
sudo cp mobile-tools /usr/local/bin/
```

Verify:

```bash
mobile-tools --version
mobile-tools --help
```

## Supported Platforms

- **Android** — via ADB
- **iOS** — via simctl (Simulator)
- **Aurora OS** — via audb
- **Desktop** — via companion app (JSON-RPC over stdin/stdout)

## Claude Code Integration

The `plugin/` directory contains a Claude Code skill. To use it, install the plugin:

```bash
claude plugin add /path/to/cli/plugin
```

Or copy the skill file to your project's `.claude/` directory.

## Commands (38 total)

Run `mobile-tools --help` for full list. Key commands:

| Category | Commands |
|----------|----------|
| Screenshot | `screenshot`, `annotate`, `analyze-screen` |
| Gestures | `tap`, `long-press`, `swipe`, `find-and-tap` |
| Text | `input`, `key` |
| UI | `ui-dump`, `find`, `tap-text` |
| Apps | `launch`, `stop`, `install`, `uninstall`, `apps` |
| Files | `push-file`, `pull-file` |
| Clipboard | `get-clipboard`, `set-clipboard` |
| System | `logs`, `clear-logs`, `system-info`, `devices`, `reboot`, `screen`, `screen-size` |
| Desktop | `launch-desktop-app`, `stop-desktop-app`, `get-window-info`, `focus-window`, `resize-window`, `get-monitors`, `get-performance-metrics` |
| Other | `shell`, `open-url`, `wait`, `current-activity` |

## Why CLI?

- **Zero startup time** — native binary vs Node.js process spawn
- **No dependencies** — single static binary, no npm install
- **Scriptable** — pipe output, use in CI/CD, shell scripts
- **Offline** — works without MCP server connection
