# Aurora phones and emulators (audb ^0.3.0)

Read this reference before controlling Aurora. The same commands work on registered
physical devices and SDK emulators. UI tree, clipboard, sensors, perf and sandbox
extensions are outside this integration. Navigate using screenshots and coordinates.

## Prepare and select a device

```sh
cargo install audb-client --version 0.3.0 --locked --force
audb --version
audb device add defaultuser@192.168.2.44 --id phone --kind physical
audb device list
# Optional persistent default for direct audb / untargeted CLI calls:
audb select phone
```

An executable `audb` in PATH takes priority over `AUDB_PATH`. An old PATH binary
produces an actionable version error; it does not fall back to `AUDB_PATH`.
Register emulators with `audb device add --kind emulator` and the SDK SSH/QMP
options shown by `audb device add --help`. Registry state `unknown` does not mean
offline: inspect the targeted readiness report.

Install the released audb-agent RPM for the device architecture explicitly when
needed (never use an ordinary application RPM as a system agent):

```sh
audb --device phone setup-device --rpm ./audb-agent-0.3.0-10.aarch64.rpm
mcp-devices-cli aurora --device phone status
mcp-devices-cli aurora --device phone doctor
mcp-devices-cli aurora --device phone capabilities
```

Root SSH is configured per device in audb; CLI and MCP use the same account and
identity. If root SSH already works, register it with
`audb device update phone --root-user root`. For one-time key provisioning,
install the [audb source revision with setup-root](https://github.com/KotDath/audb/commit/0cb1339)
and use `audb --device phone setup-root` in an interactive terminal. Published
0.3.0 does not include this provisioning command. Setup verifies both accounts
before changing the registry, preserves the persistent default, and needs no password on subsequent calls. `--check-only`
only probes access. To install the provisioning source revision explicitly:

```sh
cargo install audb-client --git https://github.com/KotDath/audb --rev 0cb1339dc2a5466902cc2fe922d4719d28dff9b5 --locked --force
```

The integration does not store root passwords or install
the agent automatically. Flutter SDK is needed to build
Flutter apps, not to run these commands against an already prepared device.

Use explicit `--device ID` on each CLI operation / `deviceId` with `platform:
"aurora"` in MCP. MCP selection is local and does not change audb's persistent
default. Unknown explicit IDs are errors, never replaced by another device.

Root execution is explicit:

```sh
mcp-devices-cli shell --platform aurora --device phone --root --i-know-what-im-doing 'id -u'
```

```json
{"action":"shell","platform":"aurora","deviceId":"phone","command":"id -u","root":true}
```

Omitting `root` uses the ordinary SSH account. Both interfaces reject root on
other platforms. The existing CLI shell opt-in and MCP metacharacter validation
still apply. Device SSH policy must allow public-key root login; provisioning
does not change `sshd` policy.

## Visual input and files

```sh
mcp-devices-cli screenshot --platform aurora --device phone -o ./phone.png
mcp-devices-cli tap --platform aurora --device phone 300 200
mcp-devices-cli long-press --platform aurora --device phone 300 200 --duration 800
mcp-devices-cli swipe --platform aurora --device phone 300 500 300 200 --duration 400
mcp-devices-cli input --platform aurora --device phone 'Привет, Aurora! 😀'
mcp-devices-cli key --platform aurora --device phone backspace
mcp-devices-cli screen-size aurora --device phone
mcp-devices-cli install --platform aurora --device phone ./app.rpm
mcp-devices-cli launch --platform aurora --device phone ru.example.app
mcp-devices-cli push-file --platform aurora ./data.bin /home/defaultuser/data.bin --device phone
mcp-devices-cli pull-file --platform aurora /home/defaultuser/data.bin ./copy.bin --device phone
```

Input reaches audb as UTF-8 stdin. Focus an editable field first. The CLI doesn't
echo submitted text. Keys are audb names, not Android keycodes; `home` is an editor
key, not a promise to open Aurora's home screen. For edge gesture aliases use
audb directly, e.g. `audb --device phone swipe edge-up`.

Coordinates refer to the actual PNG. After compression, pass its displayed
`WxH` via `tap --from-size WxH`; the CLI obtains fresh PNG dimensions for scaling.
MCP screenshot/input tools retain their existing scale mapping. After orientation
changes capture a fresh screenshot. Screenshot capture itself does not minimize
apps. Keep artifacts private; temporary screenshot files are cleaned automatically.

## Permissions

Sailjail permissions are the names declared by the application's desktop file,
e.g. `UserDirs`, not Android permission strings. Granting does not implicitly turn
off the prompt. Read state first; request `--disable-prompt` only explicitly.

```sh
mcp-devices-cli aurora --device phone permission list ru.example.app
mcp-devices-cli permission-grant aurora ru.example.app UserDirs --device phone
mcp-devices-cli aurora --device phone permission grant ru.example.app --all-requested --disable-prompt
mcp-devices-cli aurora --device phone permission prompt ru.example.app --enable
mcp-devices-cli permission-revoke aurora ru.example.app UserDirs --device phone
mcp-devices-cli permission-reset aurora ru.example.app --device phone
```

Enabling the prompt clears grants. `--all-requested` grants declared permissions
only. Installation and permission metadata retain `changed: false` for idempotent
operations. MCP uses the existing `system` module:

```json
{"action":"permission_list","platform":"aurora","deviceId":"phone","package":"ru.example.app"}
{"action":"permission_grant","platform":"aurora","deviceId":"phone","package":"ru.example.app","permission":"UserDirs","disablePrompt":true}
{"action":"permission_grant_all","platform":"aurora","deviceId":"phone","package":"ru.example.app","disablePrompt":true}
{"action":"permission_prompt","platform":"aurora","deviceId":"phone","package":"ru.example.app","enabled":false}
```

`permission_revoke` and `permission_reset` use the same generic system actions as
Android/iOS. Aurora-only fields/actions reject other platforms.

## Errors and diagnostics

The clients require a stable audb version matching `^0.3.0` (0.3.x) and public JSON `schemaVersion: 1`; both carry a concrete device
ID on targeted calls. A nonzero audb exit preserves its error code and partial
operation metadata. Lost replies/timeouts return `OUTCOME_UNKNOWN`; inspect
status and the visible result before deciding whether to repeat an action.
Do not blindly replay taps, swipes, text or installation after an uncertain result.
Shell and logs use audb's OS access policy; Android log tag filtering is unsupported.
