// Fixture-backed fake of the Hetzner Cloud API, used by unit tests (as a
// mocked fetch) and by the smoke test (as a local HTTP server).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

/** Fake tokens, one per fake project. The personal project uses the root fixtures. */
export const MOCK_TOKENS = { personal: "test-token-personal", we4water: "test-token-we4water" };
export const MOCK_TOKEN = MOCK_TOKENS.personal;
/** Authenticates fine but every request is rate limited. */
export const RATE_LIMITED_TOKEN = "test-token-ratelimited";

const PERSONAL = {
  servers: (page) => fixture(page === 1 ? "servers.page1" : "servers.page2"),
  list: (name) => fixture(name),
  metrics: { 42: "metrics.web-1", 43: "metrics.arm-worker" },
};
const WE4WATER = {
  servers: () => fixture("we4water/servers"),
  list: (name) => (name === "pricing" ? fixture("pricing") : fixture(`we4water/${name}`)),
  metrics: { 77: "we4water/metrics.sensor-gw" },
};

/** Returns { status, body } for a GET to the given Hetzner API URL. */
export function respond(url, authorization) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v1/, "");
  if (authorization === `Bearer ${RATE_LIMITED_TOKEN}`) {
    return { status: 429, body: { error: { code: "rate_limit_exceeded", message: "limit reached" } } };
  }
  const data =
    authorization === `Bearer ${MOCK_TOKENS.personal}` ? PERSONAL
    : authorization === `Bearer ${MOCK_TOKENS.we4water}` ? WE4WATER
    : null;
  if (!data) {
    return { status: 401, body: { error: { code: "unauthorized", message: "unable to authenticate" } } };
  }
  const page = Number(u.searchParams.get("page") ?? "1");
  if (u.searchParams.has("per_page") && u.searchParams.get("per_page") !== "50") {
    return { status: 400, body: { error: { code: "invalid_input", message: "expected per_page=50 in tests" } } };
  }

  switch (path) {
    case "/servers":
      return { status: 200, body: data.servers(page) };
    case "/pricing":
    case "/firewalls":
    case "/volumes":
    case "/primary_ips":
    case "/floating_ips":
    case "/load_balancers":
      return { status: 200, body: data.list(path.slice(1)) };
    case "/images": {
      const types = u.searchParams.getAll("type");
      const body = data.list("images");
      body.images = body.images.filter((i) => types.length === 0 || types.includes(i.type));
      return { status: 200, body };
    }
    case "/servers/actions": {
      if (u.searchParams.get("sort") !== "started:desc") {
        return { status: 400, body: { error: { code: "invalid_input", message: "expected sort=started:desc" } } };
      }
      return { status: 200, body: data.list("actions") };
    }
  }

  const m = path.match(/^\/servers\/(\d+)\/metrics$/);
  if (m) {
    for (const p of ["type", "start", "end", "step"]) {
      if (!u.searchParams.get(p)) {
        return { status: 400, body: { error: { code: "invalid_input", message: `missing ${p}` } } };
      }
    }
    const name = data.metrics[Number(m[1])];
    if (name) return { status: 200, body: fixture(name) };
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
