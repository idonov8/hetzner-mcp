import { cached, TTL } from "../cache";
import { WINDOW_SPEC, type Window } from "../contract";
import type {
  Action, Firewall, FloatingIp, Image, LoadBalancer, MetricsResponse, PrimaryIp,
  Pricing, Server, Volume,
} from "./types";

const DEFAULT_BASE = "https://api.hetzner.cloud/v1";
const PER_PAGE = 50;
const MAX_PAGES = 100;
const TIMEOUT_MS = 15_000;

export class ConfigError extends Error {}

export class HetznerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function token(): string {
  const t = process.env.HCLOUD_TOKEN?.trim();
  if (!t) throw new ConfigError("HCLOUD_TOKEN not configured");
  return t;
}

/**
 * The API base can only be overridden to a loopback address (used by the
 * local smoke test). This makes it impossible to misconfigure the deployment
 * into sending the token to a third-party host.
 */
export function apiBase(): string {
  const override = process.env.HCLOUD_API_URL?.trim();
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(override)) {
    return override.replace(/\/$/, "");
  }
  return DEFAULT_BASE;
}

type Query = Record<string, string | number | Array<string | number> | undefined>;

function buildUrl(path: string, query: Query = {}): string {
  const u = new URL(apiBase() + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(item));
  }
  return u.toString();
}

export async function hcloudGet<T>(path: string, query: Query = {}): Promise<T> {
  const auth = token();
  const res = await fetch(buildUrl(path, query), {
    headers: { Authorization: `Bearer ${auth}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    let code = "http_error";
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new HetznerApiError(res.status, code, `Hetzner API ${res.status} ${code} on GET ${path}: ${message}`);
  }
  return (await res.json()) as T;
}

type Paged = { meta?: { pagination?: { next_page: number | null } } };

/** Follows meta.pagination.next_page with per_page=50. */
export async function listAll<T>(path: string, key: string, query: Query = {}, maxItems = Infinity): Promise<T[]> {
  const out: T[] = [];
  let page: number | null = 1;
  for (let i = 0; page && i < MAX_PAGES && out.length < maxItems; i++) {
    const body: Paged & Record<string, unknown> = await hcloudGet(path, { ...query, page, per_page: PER_PAGE });
    out.push(...((body[key] as T[]) ?? []));
    page = body.meta?.pagination?.next_page ?? null;
  }
  return out.slice(0, maxItems);
}

// Cached resource accessors. Cache keys include nothing secret.

export const getServers = () => cached("servers", TTL.list, () => listAll<Server>("/servers", "servers"));
export const getPricing = () =>
  cached("pricing", TTL.list, async () => (await hcloudGet<{ pricing: Pricing }>("/pricing")).pricing);
export const getFirewalls = () => cached("firewalls", TTL.list, () => listAll<Firewall>("/firewalls", "firewalls"));
export const getVolumes = () => cached("volumes", TTL.list, () => listAll<Volume>("/volumes", "volumes"));
export const getPrimaryIps = () => cached("primary_ips", TTL.list, () => listAll<PrimaryIp>("/primary_ips", "primary_ips"));
export const getFloatingIps = () => cached("floating_ips", TTL.list, () => listAll<FloatingIp>("/floating_ips", "floating_ips"));
export const getLoadBalancers = () =>
  cached("load_balancers", TTL.list, () => listAll<LoadBalancer>("/load_balancers", "load_balancers"));
export const getBackupAndSnapshotImages = () =>
  cached("images:backup,snapshot", TTL.list, () =>
    listAll<Image>("/images", "images", { type: ["backup", "snapshot"], sort: "created:desc" }),
  );

/** GET /servers/actions is still a supported list endpoint (only GET /actions requires ids since 2025-01-30). */
export const getServerActions = (limit: number) =>
  cached(`servers/actions:${limit}`, TTL.list, () =>
    listAll<Action>("/servers/actions", "actions", { sort: "started:desc" }, limit),
  );

export const getServerMetrics = (serverId: number, window: Window) =>
  cached(`metrics:${serverId}:${window}`, TTL.metrics, () => {
    const { seconds, step } = WINDOW_SPEC[window];
    const end = new Date();
    const start = new Date(end.getTime() - seconds * 1000);
    return hcloudGet<MetricsResponse>(`/servers/${serverId}/metrics`, {
      type: "cpu,disk,network",
      start: start.toISOString(),
      end: end.toISOString(),
      step,
    });
  });

/** Runs fn over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
