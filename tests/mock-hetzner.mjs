// Fixture-backed fake of the Hetzner Cloud API, used by unit tests (as a
// mocked fetch) and by the smoke test (as a local HTTP server).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

export const MOCK_TOKEN = "test-token-not-real";

/** Returns { status, body } for a GET to the given Hetzner API URL. */
export function respond(url, authorization) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v1/, "");
  if (authorization !== `Bearer ${MOCK_TOKEN}`) {
    return { status: 401, body: { error: { code: "unauthorized", message: "unable to authenticate" } } };
  }
  const page = Number(u.searchParams.get("page") ?? "1");
  if (u.searchParams.has("per_page") && u.searchParams.get("per_page") !== "50") {
    return { status: 400, body: { error: { code: "invalid_input", message: "expected per_page=50 in tests" } } };
  }

  switch (path) {
    case "/servers":
      return { status: 200, body: fixture(page === 1 ? "servers.page1" : "servers.page2") };
    case "/pricing":
      return { status: 200, body: fixture("pricing") };
    case "/firewalls":
      return { status: 200, body: fixture("firewalls") };
    case "/volumes":
      return { status: 200, body: fixture("volumes") };
    case "/primary_ips":
      return { status: 200, body: fixture("primary_ips") };
    case "/floating_ips":
      return { status: 200, body: fixture("floating_ips") };
    case "/load_balancers":
      return { status: 200, body: fixture("load_balancers") };
    case "/images": {
      const types = u.searchParams.getAll("type");
      const body = fixture("images");
      body.images = body.images.filter((i) => types.length === 0 || types.includes(i.type));
      return { status: 200, body };
    }
    case "/servers/actions": {
      if (u.searchParams.get("sort") !== "started:desc") {
        return { status: 400, body: { error: { code: "invalid_input", message: "expected sort=started:desc" } } };
      }
      return { status: 200, body: fixture("actions") };
    }
  }

  const m = path.match(/^\/servers\/(\d+)\/metrics$/);
  if (m) {
    for (const p of ["type", "start", "end", "step"]) {
      if (!u.searchParams.get(p)) {
        return { status: 400, body: { error: { code: "invalid_input", message: `missing ${p}` } } };
      }
    }
    const id = Number(m[1]);
    if (id === 42) return { status: 200, body: fixture("metrics.web-1") };
    if (id === 43) return { status: 200, body: fixture("metrics.arm-worker") };
    return { status: 404, body: { error: { code: "not_found", message: "server not found" } } };
  }
  return { status: 404, body: { error: { code: "not_found", message: `no route ${path}` } } };
}

/** fetch-compatible mock; records every requested URL in calls. */
export function makeMockFetch(calls = []) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers);
    calls.push(url);
    const { status, body } = respond(url, headers.get("authorization"));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

/** Starts an HTTP server on 127.0.0.1 serving the fake API under /v1. */
export function startMockServer(port = 0) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      const url = `http://127.0.0.1${req.url}`;
      calls.push(url);
      const { status, body } = respond(url, req.headers.authorization);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(port, "127.0.0.1", () => resolve({ server, calls, port: server.address().port }));
  });
}
