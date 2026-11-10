// End-to-end smoke test: runs the built Next.js server locally against a
// fixture-backed fake Hetzner API and talks MCP to it over HTTP.
// Usage: npm run build && npm run smoke
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { COLUMNS } from "../src/contract.ts";
import { MOCK_TOKEN, startMockServer } from "../tests/mock-hetzner.mjs";

const TOOLS = Object.keys(COLUMNS);
const ARGS = { server_usage: { window: "1h" }, server_timeseries: { window: "24h" }, recent_actions: { limit: 2 } };
let passed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    });
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startApp(env) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", HCLOUD_TOKEN: "", MCP_ACCESS_KEY: "", HCLOUD_PROJECT_ID: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/`);
      return { base, child, logs };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  child.kill();
  throw new Error(`next start did not come up:\n${logs.join("")}`);
}

/** Raw 2025-era Streamable HTTP JSON-RPC call; handles JSON and SSE bodies. */
async function rpc(url, method, params, id = 1, protocolVersion) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  if (id === null) return { status: res.status };
  const ct = res.headers.get("content-type") ?? "";
  let msg;
  if (ct.includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    msg = data.map((d) => JSON.parse(d)).find((m) => m.id === id);
  } else {
    msg = JSON.parse(text);
  }
  return { status: res.status, msg };
}

function assertRows(tool, result) {
  assert.equal(result.isError ?? false, false, `${tool} returned error: ${result.content?.[0]?.text}`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(body), ["rows"]);
  assert.ok(body.rows.length > 0, `${tool} returned no rows`);
  for (const row of body.rows) {
    assert.deepEqual(Object.keys(row), [...COLUMNS[tool]], `${tool} columns`);
    for (const v of Object.values(row)) assert.ok(v === null || ["string", "number", "boolean"].includes(typeof v));
  }
  return body.rows;
}

const mock = await startMockServer();
const KEY = randomBytes(24).toString("hex");
const apps = [];

try {
  const app = await startApp({
    HCLOUD_TOKEN: MOCK_TOKEN,
    MCP_ACCESS_KEY: KEY,
    HCLOUD_PROJECT_ID: "123456",
    HCLOUD_API_URL: `http://127.0.0.1:${mock.port}/v1`,
  });
  apps.push(app);
  const url = `${app.base}/mcp/${KEY}`;
  console.log("smoke: configured server");

  await check("wrong key / other paths -> 404", async () => {
    const wrong = [
      `${app.base}/mcp/${KEY.slice(0, -1)}x`,
      `${app.base}/mcp/${KEY}x`,
      `${app.base}/mcp/short`,
      `${app.base}/mcp`,
      `${app.base}/`,
      `${app.base}/mcp/${KEY}/extra`,
      `${app.base}/api/mcp`,
    ];
    for (const u of wrong) {
      for (const method of ["POST", "GET", "OPTIONS", "DELETE"]) {
        const r = await fetch(u, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
        assert.equal(r.status, 404, `${method} ${u.replace(KEY, "<key>")} -> ${r.status}`);
      }
    }
  });

  await check("initialize (2025-06-18 streamable http)", async () => {
    const { status, msg } = await rpc(url, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    assert.equal(status, 200);
    assert.equal(msg.result.serverInfo.name, "hetzner");
    assert.ok(msg.result.capabilities.tools);
    const n = await rpc(url, "notifications/initialized", {}, null, "2025-06-18");
    assert.ok(n.status < 300);
  });

  await check("tools/list exposes exactly the 7 read-only tools", async () => {
    const { msg } = await rpc(url, "tools/list", {}, 2, "2025-06-18");
    const tools = msg.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
      assert.ok(t.description && !t.description.includes("\n"), `${t.name} one-line description`);
    }
    const usage = tools.find((t) => t.name === "server_usage");
    assert.deepEqual(usage.inputSchema.properties.window.enum, ["1h", "24h", "7d", "30d"]);
    assert.equal(usage.inputSchema.properties.window.default, "24h");
    const actions = tools.find((t) => t.name === "recent_actions");
    assert.equal(actions.inputSchema.properties.limit.minimum, 1);
    assert.equal(actions.inputSchema.properties.limit.maximum, 100);
    assert.equal(actions.inputSchema.properties.limit.default, 50);
  });

  const samples = {};
  for (const [i, tool] of TOOLS.entries()) {
    await check(`tools/call ${tool} (raw)`, async () => {
      const { msg } = await rpc(url, "tools/call", { name: tool, arguments: ARGS[tool] ?? {} }, 10 + i, "2025-06-18");
      const rows = assertRows(tool, msg.result);
      samples[tool] = rows[0];
    });
  }

  await check("server_usage defaults window to 24h", async () => {
    const { msg } = await rpc(url, "tools/call", { name: "server_usage", arguments: {} }, 30, "2025-06-18");
    assert.equal(assertRows("server_usage", msg.result)[0].window, "24h");
  });

  await check("recent_actions rejects limit 0 and 101", async () => {
    for (const limit of [0, 101]) {
      const { msg } = await rpc(url, "tools/call", { name: "recent_actions", arguments: { limit } }, 31, "2025-06-18");
      assert.ok(msg.error || msg.result?.isError, `limit ${limit} accepted`);
    }
  });

  await check("MCP SDK v2 client: connect, list and call every tool", async () => {
    const client = new Client({ name: "smoke-sdk", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    for (const tool of TOOLS) assertRows(tool, await client.callTool({ name: tool, arguments: ARGS[tool] ?? {} }));
    await client.close();
  });

  await check("server never logs the access key or token", async () => {
    const all = app.logs.join("");
    assert.ok(!all.includes(KEY), "access key found in logs");
    assert.ok(!all.includes(MOCK_TOKEN), "token found in logs");
  });

  // Instance without HCLOUD_TOKEN.
  const noToken = await startApp({ MCP_ACCESS_KEY: KEY });
  apps.push(noToken);
  await check("missing HCLOUD_TOKEN -> clear tool error", async () => {
    const u = `${noToken.base}/mcp/${KEY}`;
    await rpc(u, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "1" } });
    const { msg } = await rpc(u, "tools/call", { name: "list_servers", arguments: {} }, 2, "2025-06-18");
    assert.equal(msg.result.isError, true);
    assert.equal(msg.result.content[0].text, "HCLOUD_TOKEN not configured");
  });

  // Instance with a too-short key.
  const shortKey = "k".repeat(31);
  const weak = await startApp({ MCP_ACCESS_KEY: shortKey, HCLOUD_TOKEN: MOCK_TOKEN });
  apps.push(weak);
  await check("MCP_ACCESS_KEY shorter than 32 chars -> every request 404", async () => {
    const r = await fetch(`${weak.base}/mcp/${shortKey}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(r.status, 404);
  });

  console.log(`\nsmoke: ${passed} checks passed`);
  console.log("\nsample rows:");
  for (const [tool, row] of Object.entries(samples)) console.log(`${tool}: ${JSON.stringify(row)}`);
} catch (err) {
  console.error("\nsmoke FAILED:", err?.message ?? err);
  for (const a of apps) console.error(a.logs.join("").replaceAll(KEY, "<key>"));
  process.exitCode = 1;
} finally {
  for (const a of apps) a.child.kill();
  mock.server.close();
}
