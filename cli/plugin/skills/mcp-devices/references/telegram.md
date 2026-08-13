# Telegram Bot Testing

On-demand target for black-box e2e testing of Telegram **bots**. The bot
conversation is modelled as a UI tree over MTProto (GramJS userbot), so the
existing `ui` / `input` verbs drive it with no new commands to learn.

Capabilities: `ui`, `input`, `deviceMgmt`. There is **no `screen`** capability —
screenshots/annotate are unavailable by design (the dialog is text, so `ui_tree`
is both cheaper and complete).

---

### Install

The plugin is on-demand — install it before first use.

```bash
mcp-devices install telegram
```

---

### Credentials (env only)

All secrets are read from the environment. **Never** pass them as CLI arguments
and **never** echo them into snapshots, logs, or reports.

| Env var | Purpose |
|---------|---------|
| `TELEGRAM_API_ID` | App API id (my.telegram.org) |
| `TELEGRAM_API_HASH` | App API hash |
| `TELEGRAM_STRING_SESSION` | Disposable **test-DC** userbot session (default) |

Production DC is opt-in and gated — only used when explicitly enabled:

| Env var | Purpose |
|---------|---------|
| `TELEGRAM_ALLOW_PROD=1` | Required flag to leave the test DC |
| `TELEGRAM_PROD_STRING_SESSION` | Prod userbot session (only honoured with the flag above) |

Default and recommended path is the test DC. Switch to prod only when the bot
under test cannot run against test-DC.

---

### Model: dialog == UI tree

A chat with the bot is a screen. Messages and inline/reply buttons are nodes.

| Verb | Behaviour on a Telegram dialog |
|------|--------------------------------|
| `ui_tree` | Snapshot the dialog — recent messages plus buttons exposed as clickable nodes |
| `input_text` | Send a text message or `/command` to the bot |
| `input_tap` | Press a button, addressed by `text`, `index`, or `resourceId` |
| `ui_wait` | Block until the bot replies (next message arrives) |
| `ui_assert_*` | Assert message text / button presence in the snapshot |

Prefer `ui_tree` over any visual capture — it is the cheapest and the full
source of truth here.

---

### Buttons

Button presses are routed transparently by the adapter:

- **Inline (callback) buttons** → sent as a callback query to the bot.
- **Reply-keyboard buttons** → sent as a normal text message matching the label.

Address a button by its visible `text`, by `index` from the snapshot, or by the
stable `resourceId` the adapter assigns.

---

### Not supported (v1)

- **screenshot / annotate** — no `screen` capability; use `ui_tree` (text is cheaper and complete).
- **swipe / long-press / gestures** — meaningless in a chat transport; skip.
- **url / webapp buttons** — no browser surface to open them; skip these nodes.

---

### Looping / wizard flows

Drive multi-step bot wizards with the flow verbs instead of issuing taps one by
one.

- `flow_run` — run a recorded scenario end to end.
- `flow_batch` — run several scenarios.
- `repeat.until_found: "Готово"` — keep advancing a wizard until the terminal
  message appears (good for variable-length question flows).

---

### Security invariant

- The user's **personal** Telegram account is never touched.
- Identity is always a **disposable test-DC userbot** — a throwaway session,
  not a real human account.
- From the bot owner you need only the bot's `@username` (or token) to start a
  dialog; no access to anyone's personal account is required.
