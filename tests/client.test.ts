import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../src/cache";
import {
  ConfigError, HetznerApiError, apiBase, getServerActions, getServerMetrics, getServers, mapLimit,
} from "../src/hetzner/client";
import { MOCK_TOKENS, makeMockFetch } from "./mock-hetzner.mjs";

const P = { name: "personal", token: MOCK_TOKENS.personal };
const W = { name: "we4water", token: MOCK_TOKENS.we4water };

let calls: string[];

beforeEach(() => {
  clearCache();
  calls = [];
  vi.stubGlobal("fetch", makeMockFetch(calls));
  vi.stubEnv("HCLOUD_API_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hetzner client", () => {
  it("follows pagination with per_page=50", async () => {
    const servers = await getServers(P);
    expect(servers.map((s) => s.name)).toEqual(["web-1", "arm-worker", "db-1"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://api.hetzner.cloud/v1/servers?page=1&per_page=50");
    expect(calls[1]).toContain("page=2&per_page=50");
  });

  it("caches list responses", async () => {
    await getServers(P);
    await getServers(P);
    expect(calls).toHaveLength(2);
  });

  it("requests server actions newest first and stops at the limit", async () => {
    const actions = await getServerActions(P, 2);
    expect(actions.map((a) => a.id)).toEqual([13, 12]);
    expect(calls[0]).toContain("/v1/servers/actions?sort=started%3Adesc&page=1&per_page=50");
  });

  it("requests cpu,disk,network metrics with the window's step", async () => {
    await getServerMetrics(P, 42, "7d");
    const u = new URL(calls[0]);
    expect(u.pathname).toBe("/v1/servers/42/metrics");
    expect(u.searchParams.get("type")).toBe("cpu,disk,network");
    expect(u.searchParams.get("step")).toBe("3600");
    const span = Date.parse(u.searchParams.get("end")!) - Date.parse(u.searchParams.get("start")!);
    expect(span).toBe(7 * 86400 * 1000);
  });

  it("keeps caches and credentials separate per project", async () => {
    const [a, b] = await Promise.all([getServers(P), getServers(W)]);
    expect(a.map((s) => s.name)).toEqual(["web-1", "arm-worker", "db-1"]);
    expect(b.map((s) => s.name)).toEqual(["sensor-gw"]);
    expect(calls).toHaveLength(3);
  });

  it("scopes the cache by token, not project name (two users can both call theirs 'personal')", async () => {
    const alice = { name: "personal", token: MOCK_TOKENS.personal };
    const bob = { name: "personal", token: MOCK_TOKENS.we4water };
    const a = await getServers(alice);
    const b = await getServers(bob);
    expect(a.map((s) => s.name)).toEqual(["web-1", "arm-worker", "db-1"]);
    expect(b.map((s) => s.name)).toEqual(["sensor-gw"]);
  });

  it("throws a clear error for an empty token without calling the API", async () => {
    await expect(getServers({ name: "x", token: "" })).rejects.toThrow(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Hetzner API errors without leaking the token", async () => {
    const err = await getServers({ name: "we4water", token: "wrong-token" }).catch((e) => e);
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("unauthorized");
    expect(err.message).not.toContain("wrong-token");
  });

  it("only allows overriding the API base to loopback", () => {
    vi.stubEnv("HCLOUD_API_URL", "http://127.0.0.1:9999/v1");
    expect(apiBase()).toBe("http://127.0.0.1:9999/v1");
    vi.stubEnv("HCLOUD_API_URL", "https://evil.example.com/v1");
    expect(apiBase()).toBe("https://api.hetzner.cloud/v1");
    vi.stubEnv("HCLOUD_API_URL", "http://127.0.0.1.evil.com/v1");
    expect(apiBase()).toBe("https://api.hetzner.cloud/v1");
  });

  it("mapLimit preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});
