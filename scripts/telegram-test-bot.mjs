#!/usr/bin/env node
/**
 * telegram-test-bot.mjs -- fixture bot for the CI e2e harness.
 *
 * THIS IS NOT A PRODUCTION SERVICE. It runs as a transient background
 * subprocess during CI (see .github/workflows/telegram-e2e.yml) to give the
 * userbot harness (telegram-e2e.mjs) a live bot to interact with. It is
 * killed by the "Stop test bot" cleanup step after the e2e run.
 *
 * Implemented via the Telegram Bot API using built-in fetch (Node >= 18),
 * not GramJS -- no additional npm dependencies required.
 *
 * For test-DC bots the Bot API endpoint includes a /test/ path prefix:
 *   https://api.telegram.org/bot<TOKEN>/test/<Method>
 * The prefix is enabled when TELEGRAM_DC=test (the default in the workflow).
 *
 * Behaviour:
 *   /start command  -> inline keyboard: [Yes] [No]
 *   callback "yes"  -> answerCallbackQuery + send "Done"
 *   callback "no"   -> answerCallbackQuery + send "Done"
 *   (other inputs ignored -- this is a minimal smoke fixture)
 *
 * Required env: TELEGRAM_TEST_BOT_TOKEN
 * Optional env: TELEGRAM_DC (default "test") -- controls /test/ prefix
 */

const TOKEN = process.env.TELEGRAM_TEST_BOT_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    "[test-bot] ERROR: TELEGRAM_TEST_BOT_TOKEN is not set.\n"
  );
  process.exit(1);
}

const IS_TEST = (process.env.TELEGRAM_DC ?? "test") === "test";
// Test-DC bots require the /test/ segment between the token and the method.
const API_BASE = `https://api.telegram.org/bot${TOKEN}${IS_TEST ? "/test" : ""}`;

const log = (...args) =>
  process.stderr.write(`[test-bot] ${args.join(" ")}\n`);

/**
 * Call a Bot API method via HTTP POST.
 * Throws on network errors or when ok=false in the response.
 */
async function api(method, params = {}) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Bot API ${method} error ${data.error_code}: ${data.description}`);
  }
  return data.result;
}

/** Send a message with the Yes/No inline keyboard. */
async function sendChoiceKeyboard(chatId) {
  return api("sendMessage", {
    chat_id: chatId,
    text: "Choose:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "yes" },
          { text: "No", callback_data: "no" },
        ],
      ],
    },
  });
}

let offset = 0;

/** Process one batch of updates from getUpdates long-poll. */
async function poll() {
  let updates;
  try {
    updates = await api("getUpdates", {
      offset,
      timeout: 5,
      allowed_updates: ["message", "callback_query"],
    });
  } catch (e) {
    log("getUpdates error:", e.message);
    return;
  }

  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await handleUpdate(update);
    } catch (e) {
      log("handler error:", e.message);
    }
  }
}

async function handleUpdate(update) {
  // Text message: react to /start only.
  if (update.message?.text === "/start") {
    const from = update.message.from?.username ?? String(update.message.chat.id);
    log("received /start from", from);
    await sendChoiceKeyboard(update.message.chat.id);
    return;
  }

  // Inline button press.
  if (update.callback_query) {
    const cq = update.callback_query;
    const from = cq.from?.username ?? String(cq.message?.chat?.id ?? "?");
    log(`callback data="${cq.data}" from ${from}`);
    // Acknowledge the button press so Telegram removes the loading spinner.
    await api("answerCallbackQuery", { callback_query_id: cq.id });
    if (cq.message?.chat?.id) {
      await api("sendMessage", { chat_id: cq.message.chat.id, text: "Done" });
    }
    return;
  }
}

log(`starting (DC=${IS_TEST ? "test" : "prod"})`);

// Graceful shutdown when the CI cleanup step sends SIGTERM.
process.on("SIGTERM", () => {
  log("received SIGTERM, exiting");
  process.exit(0);
});

// Long-poll loop (runs until SIGTERM or unhandled exception).
while (true) {
  await poll();
}
