#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "swarm-report", "e2e-d8d9-2026-06-09");

const PLATFORMS = (process.argv[2] || "ios,browser,desktop").split(",").map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log("[smoke]", ...a);
const results = [];

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
      env: { ...process.env, MOBILE_PROFILE: "full" },
    });
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
    this.proc.on("exit", (code, sig) => log(`server exit code=${code} sig=${sig}`));
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
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      } catch (e) {
        log("non-json line:", line.slice(0, 200));
      }
    }
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
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

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const client = new McpClient();
  client.start();

  // wait for ready
  await new Promise(r => setTimeout(r, 1500));

  // Initialize MCP protocol
  log("initialize");
  const initRes = await client.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke-e2e", version: "1.0.0" },
  });
  results.push({ step: "initialize", ok: true, serverInfo: initRes.serverInfo });
  // send initialized notification
  client.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise(r => setTimeout(r, 500));

  // List tools
  log("tools/list");
  const tools = await client.request("tools/list", {});
  log(`  -> ${tools.tools.length} tools`);
  results.push({ step: "tools/list", ok: true, count: tools.tools.length, names: tools.tools.map(t => t.name) });

  // Device tool — list connected devices
  try {
    log("device list");
    const dev = await client.callTool("device", { action: "list" });
    const text = dev.content?.[0]?.text || JSON.stringify(dev).slice(0, 400);
    log(`  -> ${text.slice(0, 200)}`);
    results.push({ step: "device.list", ok: !dev.isError, preview: text.slice(0, 500) });
  } catch (e) {
    results.push({ step: "device.list", ok: false, error: e.message });
  }

  // Per-platform smoke
  for (const platform of PLATFORMS) {
    log(`--- platform: ${platform} ---`);
    const block = { platform, steps: [] };

    if (platform === "ios") {
      try {
        const cap = await client.callTool("screen", { action: "capture", platform: "ios", preset: "low" });
        const ok = !cap.isError;
        const txt = (cap.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "screen.capture", ok, preview: txt });
        log(`  screen.capture ok=${ok}`);
      } catch (e) { block.steps.push({ step: "screen.capture", ok: false, error: e.message }); }

      try {
        const tree = await client.callTool("ui", { action: "tree", platform: "ios", format: "semantic" });
        const ok = !tree.isError;
        const txt = (tree.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "ui.tree", ok, preview: txt });
        log(`  ui.tree ok=${ok}`);
      } catch (e) { block.steps.push({ step: "ui.tree", ok: false, error: e.message }); }
    }

    if (platform === "browser") {
      try {
        const open = await client.callTool("browser", { action: "open", url: "https://example.com", headless: true });
        const ok = !open.isError;
        const txt = (open.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "browser.open(example.com)", ok, preview: txt });
        log(`  browser.open ok=${ok}`);
      } catch (e) { block.steps.push({ step: "browser.open", ok: false, error: e.message }); }

      try {
        const snap = await client.callTool("browser", { action: "snapshot" });
        const ok = !snap.isError;
        const txt = (snap.content?.[0]?.text || "").slice(0, 400);
        block.steps.push({ step: "browser.snapshot", ok, preview: txt });
        log(`  browser.snapshot ok=${ok}`);
      } catch (e) { block.steps.push({ step: "browser.snapshot", ok: false, error: e.message }); }

      try {
        const shot = await client.callTool("browser", { action: "screenshot" });
        const ok = !shot.isError;
        block.steps.push({ step: "browser.screenshot", ok });
        log(`  browser.screenshot ok=${ok}`);
      } catch (e) { block.steps.push({ step: "browser.screenshot", ok: false, error: e.message }); }

      try {
        const ev = await client.callTool("browser", { action: "evaluate", expression: "document.title" });
        const ok = !ev.isError;
        const txt = (ev.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "browser.evaluate(document.title)", ok, preview: txt });
        log(`  browser.evaluate ok=${ok}`);
      } catch (e) { block.steps.push({ step: "browser.evaluate", ok: false, error: e.message }); }

      try {
        const close = await client.callTool("browser", { action: "close" });
        block.steps.push({ step: "browser.close", ok: !close.isError });
      } catch (e) { block.steps.push({ step: "browser.close", ok: false, error: e.message }); }
    }

    if (platform === "android") {
      try {
        const cap = await client.callTool("screen", { action: "capture", platform: "android", preset: "low" });
        const ok = !cap.isError;
        const txt = (cap.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "screen.capture", ok, preview: txt });
        log(`  screen.capture ok=${ok}`);
      } catch (e) { block.steps.push({ step: "screen.capture", ok: false, error: e.message }); }

      try {
        const tree = await client.callTool("ui", { action: "tree", platform: "android", format: "semantic" });
        const ok = !tree.isError;
        const txt = (tree.content?.[0]?.text || "").slice(0, 300);
        block.steps.push({ step: "ui.tree", ok, preview: txt });
        log(`  ui.tree ok=${ok}`);
      } catch (e) { block.steps.push({ step: "ui.tree", ok: false, error: e.message }); }

      try {
        const launch = await client.callTool("app", { action: "launch", package: "com.android.settings", platform: "android" });
        const ok = !launch.isError;
        const txt = (launch.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "app.launch(Settings)", ok, preview: txt });
        log(`  app.launch ok=${ok}`);
      } catch (e) { block.steps.push({ step: "app.launch", ok: false, error: e.message }); }

      try {
        await new Promise(r => setTimeout(r, 1500));
        const tap = await client.callTool("input", { action: "tap", x: 400, y: 800, platform: "android" });
        const ok = !tap.isError;
        const txt = (tap.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "input.tap(400,800)", ok, preview: txt });
        log(`  input.tap ok=${ok}`);
      } catch (e) { block.steps.push({ step: "input.tap", ok: false, error: e.message }); }

      try {
        const key = await client.callTool("input", { action: "key", key: "BACK", platform: "android" });
        const ok = !key.isError;
        block.steps.push({ step: "input.key(BACK)", ok });
        log(`  input.key ok=${ok}`);
      } catch (e) { block.steps.push({ step: "input.key", ok: false, error: e.message }); }

      try {
        const info = await client.callTool("system", { action: "info", platform: "android" });
        const ok = !info.isError;
        const txt = (info.content?.[0]?.text || "").slice(0, 200);
        block.steps.push({ step: "system.info", ok, preview: txt });
        log(`  system.info ok=${ok}`);
      } catch (e) { block.steps.push({ step: "system.info", ok: false, error: e.message }); }
    }

    if (platform === "desktop") {
      try {
        const r = await client.callTool("device", { action: "list" });
        block.steps.push({ step: "device.list (desktop check)", ok: !r.isError });
      } catch (e) { block.steps.push({ step: "device.list (desktop check)", ok: false, error: e.message }); }
    }

    results.push(block);
  }

  client.stop();
  const reportPath = join(OUT_DIR, "smoke-results.json");
  await writeFile(reportPath, JSON.stringify(results, null, 2));
  log(`report: ${reportPath}`);

  // Summary
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.steps) {
      for (const s of r.steps) { s.ok ? pass++ : fail++; }
    } else {
      r.ok ? pass++ : fail++;
    }
  }
  log(`SUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error("smoke fatal:", e); process.exit(2); });
