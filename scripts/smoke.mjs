// End-to-end smoke test: runs the built Next.js server locally against a
// fixture-backed fake Hetzner API and talks MCP to it over HTTP.
// Usage: npm run build && npm run smoke
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { COLUMNS } from "../src/contract.ts";
import { MOCK_TOKENS, RATE_LIMITED_TOKEN, startMockServer } from "../tests/mock-hetzner.mjs";

const TOOLS = Object.keys(COLUMNS);
const PROJECTS = ["personal", "we4water"];
/** Tools where both fake projects have data; backups_and_snapshots only has personal images. */
const BOTH = new Set(["list_servers", "server_usage", "server_timeseries", "recent_actions", "cost_breakdown", "security_overview"]);
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
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", HCLOUD_TOKENS: "", HCLOUD_TOKEN: "", MCP_ACCESS_KEY: "", HCLOUD_PROJECT_IDS: "", HCLOUD_PROJECT_ID: "", SEAL_SECRET: "", ...env },
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
    assert.equal(Object.keys(row)[0], "project", `${tool}: project must be the first column`);
    assert.ok(typeof row.project === "string" && row.project.length > 0, `${tool}: project missing`);
    for (const v of Object.values(row)) assert.ok(v === null || ["string", "number", "boolean"].includes(typeof v));
  }
  return body.rows;
}

const mock = await startMockServer();
const KEY = randomBytes(24).toString("hex");
const SEAL = randomBytes(32).toString("hex");
const API = `http://127.0.0.1:${mock.port}/v1`;
const apps = [];

async function callTool(base, name, args = {}) {
  const u = `${base}/mcp/${KEY}`;
  await rpc(u, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "1" } });
  return (await rpc(u, "tools/call", { name, arguments: args }, 2, "2025-06-18")).msg.result;
}

try {
  const app = await startApp({
    HCLOUD_TOKENS: `personal:${MOCK_TOKENS.personal},we4water:${MOCK_TOKENS.we4water}`,
    HCLOUD_PROJECT_IDS: "personal:123456,we4water:654321",
    MCP_ACCESS_KEY: KEY,
    SEAL_SECRET: SEAL,
    HCLOUD_API_URL: API,
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
      const seen = [...new Set(rows.map((r) => r.project))];
      assert.ok(seen.every((p) => PROJECTS.includes(p)), `${tool}: unexpected project ${seen}`);
      if (BOTH.has(tool)) assert.deepEqual(seen.sort(), PROJECTS, `${tool}: rows from both projects`);
      samples[tool] = rows.find((r) => r.project === "we4water") ?? rows[0];
    });
  }

  await check("recent_actions: limit applies to the merged list, newest first", async () => {
    const { msg } = await rpc(url, "tools/call", { name: "recent_actions", arguments: { limit: 2 } }, 32, "2025-06-18");
    const rows = assertRows("recent_actions", msg.result);
    assert.deepEqual(rows.map((r) => [r.project, r.id]), [["we4water", 20], ["personal", 13]]);
  });

  await check("console_url uses the per-project id", async () => {
    const { msg } = await rpc(url, "tools/call", { name: "list_servers", arguments: {} }, 33, "2025-06-18");
    const rows = assertRows("list_servers", msg.result);
    assert.equal(rows.find((r) => r.id === 77).console_url, "https://console.hetzner.com/projects/654321/servers/77/overview");
    assert.equal(rows.find((r) => r.id === 42).console_url, "https://console.hetzner.com/projects/123456/servers/42/overview");
  });

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

  // Instance with one bad project token: the whole call fails, naming the project.
  const BAD = "bad-secret-token-123";
  const badProject = await startApp({
    HCLOUD_TOKENS: `personal:${MOCK_TOKENS.personal},we4water:${BAD}`, MCP_ACCESS_KEY: KEY, HCLOUD_API_URL: API,
  });
  apps.push(badProject);
  await check("one project with a bad token -> whole call fails naming it (401)", async () => {
    for (const tool of TOOLS) {
      const result = await callTool(badProject.base, tool, ARGS[tool] ?? {});
      assert.equal(result.isError, true, `${tool} should fail`);
      assert.match(result.content[0].text, /^we4water: Hetzner API 401 unauthorized/, tool);
      assert.ok(!result.content[0].text.includes(BAD), "token leaked in error");
    }
  });

  // Instance where one project is rate limited, including the per-server metrics path.
  const limited = await startApp({
    HCLOUD_TOKENS: `personal:${MOCK_TOKENS.personal},busy:${RATE_LIMITED_TOKEN}`, MCP_ACCESS_KEY: KEY, HCLOUD_API_URL: API,
  });
  apps.push(limited);
  await check("rate-limited project -> whole call fails naming it (429)", async () => {
    const result = await callTool(limited.base, "server_usage", { window: "1h" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^busy: Hetzner API 429 rate_limit_exceeded/);
    assert.ok(!result.content[0].text.includes(RATE_LIMITED_TOKEN));
  });

  // Sealed URLs: projects travel encrypted in the path.
  const sealReq = (base, projects) =>
    fetch(`${base}/api/seal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const callAt = async (u, name, args = {}) => {
    await rpc(u, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "1" } });
    return (await rpc(u, "tools/call", { name, arguments: args }, 2, "2025-06-18")).msg.result;
  };

  await check("setup page renders with the title and explanation", async () => {
    const r = await fetch(`${app.base}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Free, easy, vibe-coded, MCP for"), "title missing");
    assert.ok(html.includes("How it works"), "explanation missing");
  });

  let sealedUrl;
  await check("seal: valid tokens -> URL that serves both projects", async () => {
    const { status, body } = await sealReq(app.base, [
      { name: "alpha", token: MOCK_TOKENS.personal, consoleId: "111" },
      { name: "beta", token: MOCK_TOKENS.we4water },
    ]);
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.url, new RegExp(`^${app.base}/mcp/v1\\.[A-Za-z0-9_-]+$`));
    for (const t of Object.values(MOCK_TOKENS)) assert.ok(!body.url.includes(t), "token visible in sealed URL");
    sealedUrl = body.url;
    const rows = assertRows("list_servers", await callAt(sealedUrl, "list_servers"));
    assert.deepEqual([...new Set(rows.map((r) => r.project))], ["alpha", "beta"]);
    assert.equal(rows.find((r) => r.project === "alpha").console_url, "https://console.hetzner.com/projects/111/servers/42/overview");
    assert.equal(rows.find((r) => r.project === "beta").console_url, null);
  });

  await check("seal: same project name, different tokens -> no cache bleed", async () => {
    const a = (await sealReq(app.base, [{ name: "personal", token: MOCK_TOKENS.personal }])).body.url;
    const b = (await sealReq(app.base, [{ name: "personal", token: MOCK_TOKENS.we4water }])).body.url;
    const ra = assertRows("list_servers", await callAt(a, "list_servers"));
    const rb = assertRows("list_servers", await callAt(b, "list_servers"));
    assert.deepEqual(ra.map((r) => r.name), ["web-1", "arm-worker", "db-1"]);
    assert.deepEqual(rb.map((r) => r.name), ["sensor-gw"]);
  });

  await check("seal: tampered, truncated or foreign blobs -> 404", async () => {
    const i = sealedUrl.length - 10;
    const tampered = sealedUrl.slice(0, i) + (sealedUrl[i] === "A" ? "B" : "A") + sealedUrl.slice(i + 1);
    for (const u of [tampered, sealedUrl.slice(0, -5), `${app.base}/mcp/v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`]) {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 404);
    }
  });

  await check("seal: bad token -> 400 naming the project, no URL", async () => {
    const { status, body } = await sealReq(app.base, [{ name: "oops", token: "not-a-real-token" }]);
    assert.equal(status, 400);
    assert.equal(body.url, undefined);
    assert.match(body.error, /^oops: Hetzner rejected this token$/);
  });

  await check("seal: invalid input -> 400 without echoing tokens", async () => {
    for (const projects of [[], [{ name: "Has Space", token: "tok" }], [{ name: "a", token: "x" }, { name: "a", token: "y" }]]) {
      const { status, body } = await sealReq(app.base, projects);
      assert.equal(status, 400, JSON.stringify(body));
      assert.ok(!JSON.stringify(body).includes("tok"));
    }
  });

  // Legacy single-token configuration.
  const legacy = await startApp({
    HCLOUD_TOKEN: MOCK_TOKENS.we4water, HCLOUD_PROJECT_ID: "777", MCP_ACCESS_KEY: KEY, HCLOUD_API_URL: API,
  });
  apps.push(legacy);
  await check("HCLOUD_TOKEN fallback -> single project 'default'", async () => {
    const rows = assertRows("list_servers", await callTool(legacy.base, "list_servers"));
    assert.deepEqual(rows.map((r) => [r.project, r.name]), [["default", "sensor-gw"]]);
    assert.equal(rows[0].console_url, "https://console.hetzner.com/projects/777/servers/77/overview");
  });

  // Instance with no tokens at all.
  const noToken = await startApp({ MCP_ACCESS_KEY: KEY });
  apps.push(noToken);
  await check("no SEAL_SECRET -> seal endpoint 503", async () => {
    const r = await fetch(`${noToken.base}/api/seal`, { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
  });

  await check("no tokens configured -> clear tool error", async () => {
    const result = await callTool(noToken.base, "list_servers");
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "HCLOUD_TOKENS not configured");
  });

  await check("server never logs the access key or any token", async () => {
    const all = apps.map((a) => a.logs.join("")).join("");
    assert.ok(!all.includes(KEY), "access key found in logs");
    for (const t of [...Object.values(MOCK_TOKENS), RATE_LIMITED_TOKEN, BAD]) assert.ok(!all.includes(t), "token found in logs");
  });

  // Instance with a too-short key.
  const shortKey = "k".repeat(31);
  const weak = await startApp({ MCP_ACCESS_KEY: shortKey, HCLOUD_TOKENS: `personal:${MOCK_TOKENS.personal}` });
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
