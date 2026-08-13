#!/usr/bin/env node
/**
 * telegram-e2e.mjs -- Telegram bot e2e harness.
 *
 * Mirrors scripts/smoke-e2e.mjs exactly: spawns the MCP server (dist/index.js),
 * speaks JSON-RPC 2.0 over stdio, and drives the telegram platform adapter via
 * the standard ui/input verbs.
 *
 * Scenario (one iteration):
 *   1. input.text("/start")    -> bot returns inline keyboard [Yes] [No]
 *   2. ui.tree                 -> locate "Yes" button bounds in uiautomator XML
 *   3. input.tap(x, y)        -> tap "Yes" using bounds centre (see conversation-
 *                                tree.ts::encodeButtonBounds for the encode/decode
 *                                invariant: button i -> centerY = i*100+40)
 *   4. ui.tree                 -> assert "Done" text present in snapshot
 *
 * Iterations: controlled by TELEGRAM_ITERATIONS (default 1).
 * Soak mode:  TELEGRAM_SOAK=true loops until the first failure.
 *
 * Required env (passed to MCP server subprocess via spawn env inheritance):
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION (from provision)
 *   TELEGRAM_BOT_USERNAME   -- @username of the bot under test (required by
 *                              TelegramAdapter.doConnect())
 * Optional env:
 *   TELEGRAM_ITERATIONS     -- integer >= 1 (default: 1)
 *   TELEGRAM_SOAK           -- "true" to loop until failure (default: false)
 *
 * Report: saved to swarm-report/telegram-e2e-<ISO-date>/ (date is dynamic).
 *
 * NOTE: this script requires real Telegram secrets to run live. Without them
 * the MCP server will reject the first tool call. See workflow header.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Date is resolved once at startup -- dynamic, not hardcoded (unlike the
// smoke-e2e.mjs which baked a specific date into the constant).
const DATE = new Date().toISOString().slice(0, 10);
const OUT_DIR = join(ROOT, "swarm-report", `telegram-e2e-${DATE}`);

const ITERATIONS = Math.max(1, parseInt(process.env.TELEGRAM_ITERATIONS ?? "1", 10));
const SOAK = (process.env.TELEGRAM_SOAK ?? "false") === "true";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "";

const log = (...args) => console.log("[tg-e2e]", ...args);

// ── McpClient ─────────────────────────────────────────────────────────────
// Identical to smoke-e2e.mjs: spawn dist/index.js, JSON-RPC 2.0 stdio,
// pending-map for request/response correlation, per-call timeout.

class McpClient {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    this.proc = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MOBILE_PROFILE: "full",
        // The TelegramAdapter reads TELEGRAM_BOT_USERNAME from the server env
        // to populate TelegramAdapterConfig.botUsername (used by doConnect()).
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      },
    });
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) =>
      process.stderr.write(`[server] ${chunk}`)
    );
    this.proc.on("exit", (code, sig) =>
      log(`server exit code=${code} sig=${sig}`)
    );
  }

  onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error)
            reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      } catch {
        log("non-json line:", line.slice(0, 200));
      }
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload =
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.proc.stdin.write(payload);
    });
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args }, 45000);
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
  }
}

// ── uiautomator XML helpers ───────────────────────────────────────────────
// The telegram adapter serialises the conversation to uiautomator-XML via
// conversation-tree.ts::serializeSnapshotToXml. Button bounds follow the
// encode invariant: button i -> [0, i*100][1000, i*100+80], so
// centerX=500, centerY=i*100+40. We extract them from the XML rather than
// hardcoding, so the harness stays correct if history depth shifts the index.

/**
 * Find the (x, y) centre of the first clickable node with text === buttonText.
 * Returns null if not found. Uses the same bounds attribute format produced by
 * conversation-tree.ts::boundsAttr: "[x1,y1][x2,y2]".
 */
function findButtonCenter(xml, buttonText) {
  const nodeRe = /<node ([^/]+)\/>/g;
  let match;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const textM = attrs.match(/\btext="([^"]*)"/);
    const clickM = attrs.match(/\bclickable="([^"]*)"/);
    const boundsM = attrs.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (
      textM && clickM && boundsM &&
      clickM[1] === "true" &&
      textM[1] === buttonText
    ) {
      return {
        x: Math.floor((parseInt(boundsM[1]) + parseInt(boundsM[3])) / 2),
        y: Math.floor((parseInt(boundsM[2]) + parseInt(boundsM[4])) / 2),
      };
    }
  }
  return null;
}

/**
 * Return true if the uiautomator XML contains any node with the given text.
 * Checks both raw and XML-escaped forms so "&amp;" / "&lt;" variants match.
 */
function treeContainsText(xml, text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return xml.includes(`text="${text}"`) || xml.includes(`text="${escaped}"`);
}

// ── One e2e iteration ─────────────────────────────────────────────────────

/**
 * Execute one round of the telegram bot e2e scenario.
 * Returns a steps array in the same format as smoke-e2e.mjs block.steps.
 */
async function runIteration(client, iteration) {
  const steps = [];
  const label = `[iter ${iteration}]`;

  // ── 1. Send /start ────────────────────────────────────────────────────
  // This triggers TelegramAdapter.ensureConnected() -> doConnect() on the
  // first call. The adapter reads TELEGRAM_BOT_USERNAME and TELEGRAM_*
  // credentials from the server process env (inherited from CI).
  try {
    log(`${label} input.text /start`);
    const res = await client.callTool("input", {
      action: "text",
      text: "/start",
      platform: "telegram",
    });
    const ok = !res.isError;
    const preview = (res.content?.[0]?.text ?? "").slice(0, 200);
    steps.push({ step: "input.text(/start)", ok, preview });
    log(`  -> ok=${ok}`);
    if (!ok) return steps; // cannot proceed without /start
  } catch (e) {
    steps.push({ step: "input.text(/start)", ok: false, error: e.message });
    log(`  -> ERROR: ${e.message}`);
    return steps;
  }

  // Allow the fixture bot time to respond.
  await new Promise((r) => setTimeout(r, 2000));

  // ── 2. ui_tree -- verify the inline keyboard appeared ─────────────────
  let xml = "";
  try {
    log(`${label} ui.tree`);
    const res = await client.callTool("ui", {
      action: "tree",
      platform: "telegram",
      format: "semantic",
    });
    const ok = !res.isError;
    xml = res.content?.[0]?.text ?? "";
    const hasYes = treeContainsText(xml, "Yes");
    steps.push({
      step: "ui.tree (expect Yes button)",
      ok: ok && hasYes,
      preview: xml.slice(0, 400),
    });
    log(`  -> ok=${ok} hasYes=${hasYes}`);
    if (!hasYes) {
      steps.push({
        step: "input.tap(Yes)",
        ok: false,
        error: '"Yes" button not found in ui_tree after /start',
      });
      return steps;
    }
  } catch (e) {
    steps.push({ step: "ui.tree (after /start)", ok: false, error: e.message });
    log(`  -> ERROR: ${e.message}`);
    return steps;
  }

  // ── 3. Tap "Yes" ──────────────────────────────────────────────────────
  // Extract centre from bounds attribute so the index shift (if there is prior
  // history) doesn't break the tap. See conversation-tree.ts::encodeButtonBounds.
  try {
    const center = findButtonCenter(xml, "Yes");
    if (!center) throw new Error('"Yes" found in text but bounds are missing');
    log(`${label} input.tap Yes at x=${center.x} y=${center.y}`);
    const res = await client.callTool("input", {
      action: "tap",
      x: center.x,
      y: center.y,
      platform: "telegram",
    });
    const ok = !res.isError;
    const preview = (res.content?.[0]?.text ?? "").slice(0, 200);
    steps.push({ step: "input.tap(Yes)", ok, preview });
    log(`  -> ok=${ok}`);
    if (!ok) return steps;
  } catch (e) {
    steps.push({ step: "input.tap(Yes)", ok: false, error: e.message });
    log(`  -> ERROR: ${e.message}`);
    return steps;
  }

  // Allow the fixture bot time to reply "Done".
  await new Promise((r) => setTimeout(r, 2000));

  // ── 4. ui_tree -- assert "Done" present ──────────────────────────────
  try {
    log(`${label} ui.tree (assert Done)`);
    const res = await client.callTool("ui", {
      action: "tree",
      platform: "telegram",
      format: "semantic",
    });
    const ok = !res.isError;
    const xml2 = res.content?.[0]?.text ?? "";
    const hasDone = treeContainsText(xml2, "Done");
    steps.push({
      step: "ui.tree (assert Done)",
      ok: ok && hasDone,
      preview: xml2.slice(0, 400),
    });
    log(`  -> ok=${ok} hasDone=${hasDone}`);
  } catch (e) {
    steps.push({ step: "ui.tree (assert Done)", ok: false, error: e.message });
    log(`  -> ERROR: ${e.message}`);
  }

  return steps;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  const client = new McpClient();
  client.start();

  // Wait for the MCP server process to be ready (mirrors smoke-e2e.mjs).
  await new Promise((r) => setTimeout(r, 1500));

  // MCP protocol handshake.
  log("initialize");
  const initRes = await client.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "telegram-e2e", version: "1.0.0" },
  });
  log(`  -> server: ${initRes.serverInfo?.name ?? "(unknown)"}`);
  client.proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 500));

  // List available tools for reference / debugging.
  const toolsRes = await client.request("tools/list", {});
  log(`tools/list -> ${toolsRes.tools.length} tools`);
  const toolNames = toolsRes.tools.map((t) => t.name);
  log(`  names: ${toolNames.join(", ")}`);

  // Sanity-check: verify the device tool is reachable (does not require auth).
  let setupOk = true;
  try {
    log("device.list");
    const dev = await client.callTool("device", { action: "list" });
    const preview = (dev.content?.[0]?.text ?? JSON.stringify(dev)).slice(0, 300);
    log(`  -> ${preview}`);
  } catch (e) {
    log(`device.list ERROR: ${e.message}`);
    setupOk = false;
  }

  const allResults = [];
  let totalFail = 0;

  if (!setupOk) {
    log("ABORT: device setup check failed");
    totalFail++;
  } else {
    let iteration = 0;
    while (true) {
      iteration++;
      log(`=== iteration ${iteration} / ${SOAK ? "soak" : ITERATIONS} ===`);
      const steps = await runIteration(client, iteration);
      const iterFail = steps.filter((s) => !s.ok).length;
      totalFail += iterFail;
      allResults.push({ iteration, steps, fail: iterFail });

      // Soak: continue until failure. Fixed count: stop after ITERATIONS.
      const done = SOAK ? iterFail > 0 : iteration >= ITERATIONS;
      if (done) break;
    }
  }

  client.stop();

  // ── Save report (mirrors smoke-e2e.mjs writeFile pattern) ─────────────
  const reportPath = join(OUT_DIR, "telegram-e2e-results.json");
  await writeFile(
    reportPath,
    JSON.stringify({ date: DATE, totalFail, iterations: allResults }, null, 2)
  );
  log(`report: ${reportPath}`);

  let totalPass = 0;
  for (const r of allResults) {
    for (const s of r.steps) {
      if (s.ok) totalPass++;
    }
  }
  log(`SUMMARY pass=${totalPass} fail=${totalFail}`);
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("telegram-e2e fatal:", e);
  process.exit(2);
});
