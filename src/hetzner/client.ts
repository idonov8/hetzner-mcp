import { cached, TTL } from "../cache";
import { WINDOW_SPEC, type Window } from "../contract";
import { ConfigError, type Project } from "../projects";
import type {
  Action, Firewall, FloatingIp, Image, LoadBalancer, MetricsResponse, PrimaryIp,
  Pricing, Server, Volume,
} from "./types";

const DEFAULT_BASE = "https://api.hetzner.cloud/v1";
const PER_PAGE = 50;
const MAX_PAGES = 100;
const TIMEOUT_MS = 15_000;

export { ConfigError };

export class HetznerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

export async function hcloudGet<T>(project: Project, path: string, query: Query = {}): Promise<T> {
  if (!project.token) throw new ConfigError(`${project.name}: token is empty`);
  const auth = project.token;
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
export async function listAll<T>(
  project: Project, path: string, key: string, query: Query = {}, maxItems = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  let page: number | null = 1;
  for (let i = 0; page && i < MAX_PAGES && out.length < maxItems; i++) {
    const body: Paged & Record<string, unknown> = await hcloudGet(project, path, { ...query, page, per_page: PER_PAGE });
    out.push(...((body[key] as T[]) ?? []));
    page = body.meta?.pagination?.next_page ?? null;
  }
  return out.slice(0, maxItems);
}

// Cached resource accessors, keyed per project. Cache keys hold no secrets.

const ck = (p: Project, key: string) => `${p.name}\u0000${key}`;

export const getServers = (p: Project) =>
  cached(ck(p, "servers"), TTL.list, () => listAll<Server>(p, "/servers", "servers"));
export const getPricing = (p: Project) =>
  cached(ck(p, "pricing"), TTL.list, async () => (await hcloudGet<{ pricing: Pricing }>(p, "/pricing")).pricing);
export const getFirewalls = (p: Project) =>
  cached(ck(p, "firewalls"), TTL.list, () => listAll<Firewall>(p, "/firewalls", "firewalls"));
export const getVolumes = (p: Project) =>
  cached(ck(p, "volumes"), TTL.list, () => listAll<Volume>(p, "/volumes", "volumes"));
export const getPrimaryIps = (p: Project) =>
  cached(ck(p, "primary_ips"), TTL.list, () => listAll<PrimaryIp>(p, "/primary_ips", "primary_ips"));
export const getFloatingIps = (p: Project) =>
  cached(ck(p, "floating_ips"), TTL.list, () => listAll<FloatingIp>(p, "/floating_ips", "floating_ips"));
export const getLoadBalancers = (p: Project) =>
  cached(ck(p, "load_balancers"), TTL.list, () => listAll<LoadBalancer>(p, "/load_balancers", "load_balancers"));
export const getBackupAndSnapshotImages = (p: Project) =>
  cached(ck(p, "images:backup,snapshot"), TTL.list, () =>
    listAll<Image>(p, "/images", "images", { type: ["backup", "snapshot"], sort: "created:desc" }),
  );

/** GET /servers/actions is still a supported list endpoint (only GET /actions requires ids since 2025-01-30). */
export const getServerActions = (p: Project, limit: number) =>
  cached(ck(p, `servers/actions:${limit}`), TTL.list, () =>
    listAll<Action>(p, "/servers/actions", "actions", { sort: "started:desc" }, limit),
  );

export const getServerMetrics = (p: Project, serverId: number, window: Window) =>
  cached(ck(p, `metrics:${serverId}:${window}`), TTL.metrics, () => {
    const { seconds, step } = WINDOW_SPEC[window];
    const end = new Date();
    const start = new Date(end.getTime() - seconds * 1000);
    return hcloudGet<MetricsResponse>(p, `/servers/${serverId}/metrics`, {
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
