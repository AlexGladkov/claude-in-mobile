# Platform Plugin: Aurora

Automate Aurora OS phones, tablets and SDK emulators through audb.

---

## Overview

The Aurora plugin provides screenshots, coordinate input, Unicode text, named
keys, application management, file transfer, shell access, logs, device info and
Sailjail permissions. It uses the same platform plugin, capability adapters and
core MCP modules as Android and iOS. The native CLI uses the same audb transport.

Navigation uses screenshots and coordinates. UI tree, element search, clipboard,
sensor/network simulation, performance and sandbox extensions are not exposed
by this integration.

## When to use it

- **UI automation:** Tap, swipe and fill forms using current screenshots.
- **App testing:** Install RPMs, launch/stop applications and inspect inventory.
- **Permission testing:** Inspect declared Sailjail permissions, grants and prompts.
- **Device debugging:** Read device info and logs or execute shell commands.
- **File transfer:** Push fixtures and pull results from accessible device paths.
- **Phone and emulator testing:** Run the same supported actions on both targets.

---

## Prerequisites

### audb (required)

Install the external Rust CLI and make it available in `PATH`:

```sh
cargo install audb-client --version 0.3.0 --locked --force
audb --version
```

The integration requires stable audb `^0.3.0` versions (0.3.x) and public JSON
schema 1. An executable in `PATH` takes priority over `AUDB_PATH`. An incompatible
PATH binary produces an update instruction instead of falling back silently.

A host Aurora SDK is not required to control a prepared physical device.
Flutter Aurora SDK is needed when building Flutter applications. SDK emulators
also require their VM, SDK SSH identity and QMP configuration.

### Devices

Physical devices need ordinary-user SSH access. Establish that connection and
verify the device's host key first; audb uses existing `known_hosts` entries and
SSH profiles/agent identities.

```sh
ssh defaultuser@192.168.2.44 true
audb device add defaultuser@192.168.2.44 --id phone --kind physical
audb device list
```

Custom ports and identities can be supplied through an SSH profile or
`--port`/`--key`. Existing SDK emulator configuration is migrated as `emulator`.
For additional VMs, use `audb device add --kind emulator` with `--port`, `--key`,
`--qmp`, `--sdk-root` and `--emulator-name`; see `audb device add --help`.

Install the audb-agent system RPM for the target architecture explicitly:

```sh
# Use the aarch64 RPM on an ARM64 phone; use the x86_64 RPM on an x86_64 VM.
audb --device phone setup-device --rpm ./audb-agent-0.3.0-10.aarch64.rpm
```

Installation uses the device's configured root SSH or a one-time hidden
`devel-su` password. Ordinary input, screenshots and permission management use
the agent through the ordinary SSH account.

### Root access (optional)

Shell runs as the ordinary user by default. Root shell and current log access
require working root SSH. If it already works, register the account:

```sh
audb device update phone --root-user root
```

For one-time key provisioning, the [audb source revision with setup-root](https://github.com/KotDath/audb/commit/0cb1339)
provides the following command. It is not included in the published 0.3.0 release:

```sh
cargo install audb-client --git https://github.com/KotDath/audb --rev 0cb1339dc2a5466902cc2fe922d4719d28dff9b5 --locked --force
audb --device phone setup-root
audb --device phone setup-root --check-only
```

Setup asks for a hidden `devel-su` password when needed, provisions an identity
for that device and verifies ordinary and root SSH before saving the registry.
The password is not saved. Existing emulator root access is reused. Device SSH
policy must allow root public-key login; setup does not edit that policy.

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-aurora
```

### 2. Enable the platform

```sh
mcp-devices install aurora
```

This enables the platform in the existing mcp-devices configuration. Registering
devices and installing the device agent remain explicit audb setup steps.

### 3. Restart MCP server

The Aurora platform loads on the next server start.

### 4. Verify

```sh
mcp-devices platforms
mcp-devices doctor aurora
mcp-devices-cli aurora --device phone doctor
mcp-devices-cli aurora --device phone capabilities
```

The general doctor checks the host audb version. The targeted Aurora doctor and
capabilities commands inspect device readiness, agent capabilities and root SSH.
A registry state of `unknown` means connectivity has not been probed.

---

## Tools & Actions

### Core modules

| Module | Key Actions | Use |
|--------|-------------|-----|
| **input** | `tap`, `double_tap`, `long_press`, `swipe`, `text`, `key` | Coordinates, gestures, UTF-8 text and named keys |
| **app** | `launch`, `stop`, `install`, `list`, `uninstall` | Application lifecycle and RPM management |
| **system** | `shell`, `logs`, `clear_logs`, `info`, `open_url`, `file_push`, `file_pull` | Device diagnostics and files |
| **system** | `permission_grant`, `permission_revoke`, `permission_reset`, `permission_list`, `permission_grant_all`, `permission_prompt` | Sailjail permissions and prompt state |
| **screen** | `capture` | Screenshots with existing compression presets |
| **device** | `list`, `set`, `set_target`, `enable_module`, `disable_module` | Platform and device selection |
| **flow** | `batch`, `run`, `parallel` | Sequences of supported actions |

Use `platform: 'aurora'` and a registered `deviceId` on MCP actions. Selection
through MCP is local to the adapter and does not change audb's persistent default.
Unknown explicit Aurora IDs fail instead of selecting another device.

### Example invocations (action syntax)

```json
// Inspect registered devices and select the platform.
device(action: 'list', platform: 'aurora')
device(action: 'set_target', target: 'aurora')
device(action: 'set', platform: 'aurora', deviceId: 'phone')

// Launch an installed application.
app(action: 'launch', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app')

// Capture a screenshot, then choose coordinates from the returned image.
screen(action: 'capture', platform: 'aurora', deviceId: 'phone')
input(action: 'tap', platform: 'aurora', deviceId: 'phone', x: 100, y: 120)
input(action: 'text', platform: 'aurora', deviceId: 'phone', text: 'Привет, Aurora! 😀')
input(action: 'swipe', platform: 'aurora', deviceId: 'phone', direction: 'up')

// Inspect the device or execute an explicit root command.
system(action: 'info', platform: 'aurora', deviceId: 'phone')
system(action: 'shell', platform: 'aurora', deviceId: 'phone', command: 'id -u', root: true)
```

MCP maps compressed screenshot coordinates to device pixels. Capture a new image
after orientation changes. Input keys are audb names such as `backspace`; they
are not Android keycodes. `home` is an editor key, not a system home gesture.

### Native CLI

```sh
mcp-devices-cli screenshot --platform aurora --device phone -o ./phone.png
mcp-devices-cli tap --platform aurora --device phone 100 120
mcp-devices-cli swipe --platform aurora --device phone 300 500 300 200 --duration 400
mcp-devices-cli input --platform aurora --device phone 'Привет, Aurora! 😀'
mcp-devices-cli screen-size aurora --device phone
mcp-devices-cli install --platform aurora --device phone ./app.rpm
mcp-devices-cli shell --platform aurora --device phone --root --i-know-what-im-doing 'id -u'
```

CLI coordinates use actual PNG pixels; use `--from-size WxH` when acting on a
resized image. Both interfaces forward explicit root requests only on Aurora.
The existing CLI shell opt-in and MCP shell validation apply.

---

## Example Workflows

### Workflow 1: Interact with an application on a phone or emulator

```json
// Use deviceId: 'emulator' instead to run on the registered SDK VM.
app(action: 'launch', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app')
screen(action: 'capture', platform: 'aurora', deviceId: 'phone')

// Coordinates are illustrative: inspect the image before choosing a target.
input(action: 'tap', platform: 'aurora', deviceId: 'phone', x: 100, y: 120)
input(action: 'text', platform: 'aurora', deviceId: 'phone', text: 'Test input')
input(action: 'key', platform: 'aurora', deviceId: 'phone', key: 'backspace')
screen(action: 'capture', platform: 'aurora', deviceId: 'phone')
```

### Workflow 2: Inspect and grant Sailjail permissions

```json
system(action: 'permission_list', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app')

// Explicitly allow disabling the prompt before granting a declared permission.
system(action: 'permission_grant', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app', permission: 'UserDirs', disablePrompt: true)

// Alternatively grant all permissions declared by this application.
system(action: 'permission_grant_all', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app', disablePrompt: true)

// Restore the permission dialog and clear saved grants.
system(action: 'permission_prompt', platform: 'aurora', deviceId: 'phone', package: 'ru.example.app', enabled: true)
```

Permission names come from the application's desktop file, not Android permission
strings. Granting preserves existing grants and does not implicitly disable the
prompt. Enabling the prompt clears grants; `permission_reset` also enables it
without clearing application data. Already-satisfied operations retain
`changed: false` in the audb result.

### Workflow 3: Transfer files and inspect logs

```json
system(action: 'file_push', platform: 'aurora', deviceId: 'phone', localPath: './fixture.json', remotePath: '/home/defaultuser/fixture.json')
system(action: 'shell', platform: 'aurora', deviceId: 'phone', command: 'uname -a')
system(action: 'logs', platform: 'aurora', deviceId: 'phone', lines: 50)
system(action: 'file_pull', platform: 'aurora', deviceId: 'phone', remotePath: '/home/defaultuser/fixture.json', localPath: './result.json')
```

File operations obey the SSH user's access rights. Logs require root SSH; Android
log tag filtering is not supported on Aurora.

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| `AUDB_NOT_INSTALLED` / `AUDB_VERSION_UNSUPPORTED` | Missing or incompatible host CLI | Install audb 0.3.x and check the first executable in PATH |
| `DEVICE_REQUIRED` / unknown device ID | Missing default or unregistered explicit ID | Inspect `audb device list`; register the device and pass its exact ID |
| SSH connection fails | Host key, account, identity, profile or port mismatch | Verify ordinary SSH using the registered connection parameters |
| Agent-backed operation unavailable | Agent missing or protocol/capability mismatch | Inspect targeted doctor/capabilities; install the matching audb-agent RPM explicitly |
| Root shell or logs fail | Root SSH is unavailable | Configure and verify root access for that device; ordinary agent actions do not require root SSH |
| Permission grant fails | Permission undeclared or prompt still enabled | Read `permission_list`; use a declared permission and opt into disabling the prompt explicitly |
| UI tree / element search unavailable | Aurora UI inspection is not supported | Capture a screenshot and use coordinate input |
| Tap lands at the wrong position | Stale orientation or wrong screenshot dimensions | Capture again; use MCP scaling or CLI `--from-size` for resized images |
| `OUTCOME_UNKNOWN` | Timeout or missing operation reply | Inspect device state and visible results before deciding whether to repeat the action |

Typed audb failures preserve their error code and partial operation metadata.
The wrappers do not automatically repeat modifying actions after uncertain results.

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Platform configuration and module visibility
- [Android Platform](./plugin-android.md) — Corresponding Android integration
- [iOS Platform](./plugin-ios.md) — Corresponding iOS integration
- [Built-in Tools Reference](./built-in-tools.md) — Shared MCP action catalog
- [Aurora Agent Reference](../../cli/plugin/skills/mcp-devices/references/aurora.md) — CLI setup, coordinates, permissions and recovery
- [audb v0.3.0 contract](https://github.com/KotDath/audb/tree/v0.3.0) — Released external CLI API
