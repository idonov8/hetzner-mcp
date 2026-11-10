// Pure transforms from Hetzner API payloads to contract rows.
// No I/O here: everything is unit-tested against fixture JSON.

import { finalizeRows, type Row, type Window } from "./contract";
import type {
  Action, Firewall, FirewallRule, FloatingIp, Image, LoadBalancer, MetricsResponse,
  PrimaryIp, Pricing, Server, Volume,
} from "./hetzner/types";

/** Hetzner accounts traffic in binary units (20 TB included = 20 * 1024^4 bytes). */
const BYTES_PER_GB = 1024 ** 3;
const DAY_MS = 86_400_000;
const WORLD = new Set(["0.0.0.0/0", "::/0"]);
const DEFAULT_BACKUP_PCT = 20;

const num = (s: string | number | null | undefined): number | null => {
  if (s === null || s === undefined) return null;
  const n = typeof s === "number" ? s : Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const ageDays = (iso: string | null | undefined, now: Date): number | null =>
  iso ? (now.getTime() - new Date(iso).getTime()) / DAY_MS : null;

/** ISO 8601 UTC, without a zero milliseconds part: 2026-11-09T12:00:00Z. */
export const toIso = (d: Date): string => d.toISOString().replace(".000Z", "Z");
const isoUtc = (iso: string | null | undefined): string | null => (iso ? toIso(new Date(iso)) : null);

// ---------------------------------------------------------------- pricing

export function backupPercent(pricing: Pricing | null): number {
  return num(pricing?.server_backup?.percentage) ?? DEFAULT_BACKUP_PCT;
}

/** Monthly server price (net/gross) for a server type at a location; falls back to prices embedded in the server object. */
export function serverPrice(server: Server, pricing: Pricing | null): { net: number; gross: number } | null {
  const loc = server.location.name;
  const fromPricing = pricing?.server_types
    .find((t) => t.name === server.server_type.name)
    ?.prices.find((p) => p.location === loc);
  const p = fromPricing ?? server.server_type.prices?.find((x) => x.location === loc);
  if (!p) return null;
  const net = num(p.price_monthly.net);
  const gross = num(p.price_monthly.gross);
  return net === null || gross === null ? null : { net, gross };
}

function locationPrice(
  list: Array<{ type?: string; name?: string; prices: Array<{ location: string; price_monthly: { net: string; gross: string } }> }> | undefined,
  match: (e: { type?: string; name?: string }) => boolean,
  location: string,
): { net: number; gross: number } | null {
  const p = list?.find(match)?.prices.find((x) => x.location === location);
  if (!p) return null;
  const net = num(p.price_monthly.net);
  const gross = num(p.price_monthly.gross);
  return net === null || gross === null ? null : { net, gross };
}

// ---------------------------------------------------------------- list_servers

export function isTypeDeprecated(server: Server): boolean {
  const st = server.server_type;
  const atLocation = st.locations?.find((l) => l.name === server.location.name);
  return Boolean(atLocation?.deprecation) || Boolean(st.deprecation) || st.deprecated === true;
}

export function consoleUrl(projectId: string | undefined, serverId: number): string | null {
  const pid = projectId?.trim();
  if (!pid || !/^\d+$/.test(pid)) return null;
  return `https://console.hetzner.com/projects/${pid}/servers/${serverId}/overview`;
}

export function serversToRows(
  servers: Server[],
  pricing: Pricing | null,
  opts: { now: Date; projectId?: string },
): Row[] {
  const pct = backupPercent(pricing);
  return finalizeRows(
    "list_servers",
    servers.map((s) => {
      const st = s.server_type;
      const price = serverPrice(s, pricing);
      const backups = s.backup_window !== null && s.backup_window !== undefined;
      const included =
        num(s.included_traffic) ?? num(st.prices?.find((p) => p.location === s.location.name)?.included_traffic);
      const out = num(s.outgoing_traffic);
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        type: st.name,
        type_description: st.description,
        cpu_type: st.cpu_type,
        architecture: st.architecture,
        cores: st.cores,
        memory_gb: st.memory,
        disk_gb: s.primary_disk_size ?? st.disk,
        location: s.location.name,
        city: s.location.city,
        country: s.location.country,
        // server.datacenter was removed from the API on 2026-07-01; the
        // location description ("Falkenstein DC Park 1") is the closest match.
        datacenter: s.datacenter?.name ?? s.location.description ?? null,
        ipv4: s.public_net.ipv4?.ip ?? null,
        ipv6: s.public_net.ipv6?.ip ?? null,
        image: s.image ? (s.image.name ?? s.image.description) : null,
        os_flavor: s.image?.os_flavor ?? null,
        created: isoUtc(s.created),
        age_days: ageDays(s.created, opts.now),
        backups_enabled: backups,
        backup_window: s.backup_window ?? null,
        delete_protected: s.protection.delete,
        rebuild_protected: s.protection.rebuild,
        rescue_enabled: s.rescue_enabled,
        locked: s.locked,
        firewall_count: s.public_net.firewalls?.length ?? 0,
        volume_count: s.volumes?.length ?? 0,
        labels: JSON.stringify(s.labels ?? {}),
        traffic_out_gb: out === null ? null : out / BYTES_PER_GB,
        traffic_included_gb: included === null ? null : included / BYTES_PER_GB,
        traffic_used_pct: out !== null && included ? (out / included) * 100 : null,
        price_monthly_eur: price?.net ?? null,
        backup_monthly_eur: backups ? (price ? (price.net * pct) / 100 : null) : 0,
        type_deprecated: isTypeDeprecated(s),
        console_url: consoleUrl(opts.projectId, s.id),
      };
    }),
  );
}

// ---------------------------------------------------------------- metrics

type Series = Array<[number, number | null]>;

function series(m: MetricsResponse | null, name: string): Series {
  const vals = m?.metrics.time_series[name]?.values ?? [];
  return vals.map(([t, v]) => [t, num(v)]);
}

const finite = (s: Series): number[] => s.map(([, v]) => v).filter((v): v is number => v !== null);
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
const scale = (x: number | null, f: number): number | null => (x === null ? null : x * f);

/**
 * Hetzner's "cpu" series is percent per vCPU: 100 means one full vCPU, so a
 * 4-vCPU server peaks at 400. Divide by cores to get 0-100 of the whole
 * machine (documented on GET /servers/{id}/metrics).
 */
export function normalizeCpu(value: number | null, cores: number): number | null {
  if (value === null) return null;
  const pct = value / Math.max(1, cores);
  return Math.min(100, Math.max(0, pct));
}

const BYTES_TO_MBIT = 8 / 1e6;
const BYTES_TO_MB = 1 / 1e6;

export function usageRow(server: Server, window: Window, metrics: MetricsResponse | null): Record<string, unknown> {
  const base = { server_id: server.id, server_name: server.name, status: server.status, window };
  const empty = {
    cpu_now_pct: null, cpu_avg_pct: null, cpu_max_pct: null,
    disk_read_iops_avg: null, disk_write_iops_avg: null, disk_read_mbps_avg: null, disk_write_mbps_avg: null,
    net_in_mbps_avg: null, net_out_mbps_avg: null, net_in_gb_total: null, net_out_gb_total: null,
    points: null,
  };
  if (server.status !== "running" || !metrics) return { ...base, ...empty };

  const cores = server.server_type.cores;
  const step = num(metrics.metrics.step) ?? 0;
  const cpu = finite(series(metrics, "cpu")).map((v) => normalizeCpu(v, cores) as number);
  const netIn = finite(series(metrics, "network.0.bandwidth.in"));
  const netOut = finite(series(metrics, "network.0.bandwidth.out"));
  const total = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) * step) / BYTES_PER_GB : null);

  return {
    ...base,
    cpu_now_pct: cpu.length ? cpu[cpu.length - 1] : null,
    cpu_avg_pct: avg(cpu),
    cpu_max_pct: max(cpu),
    disk_read_iops_avg: avg(finite(series(metrics, "disk.0.iops.read"))),
    disk_write_iops_avg: avg(finite(series(metrics, "disk.0.iops.write"))),
    disk_read_mbps_avg: scale(avg(finite(series(metrics, "disk.0.bandwidth.read"))), BYTES_TO_MB),
    disk_write_mbps_avg: scale(avg(finite(series(metrics, "disk.0.bandwidth.write"))), BYTES_TO_MB),
    net_in_mbps_avg: scale(avg(netIn), BYTES_TO_MBIT),
    net_out_mbps_avg: scale(avg(netOut), BYTES_TO_MBIT),
    net_in_gb_total: total(netIn),
    net_out_gb_total: total(netOut),
    points: cpu.length,
  };
}

export function usageRows(
  servers: Server[],
  window: Window,
  metricsById: Map<number, MetricsResponse | null>,
): Row[] {
  return finalizeRows("server_usage", servers.map((s) => usageRow(s, window, metricsById.get(s.id) ?? null)));
}

export function timeseriesRows(server: Server, metrics: MetricsResponse | null): Array<Record<string, unknown>> {
  if (!metrics) return [];
  const cores = server.server_type.cores;
  const byTs = new Map<number, { cpu?: number | null; r?: number | null; w?: number | null; i?: number | null; o?: number | null }>();
  const put = (name: string, key: "cpu" | "r" | "w" | "i" | "o") => {
    for (const [t, v] of series(metrics, name)) {
      const e = byTs.get(t) ?? {};
      e[key] = v;
      byTs.set(t, e);
    }
  };
  put("cpu", "cpu");
  put("disk.0.iops.read", "r");
  put("disk.0.iops.write", "w");
  put("network.0.bandwidth.in", "i");
  put("network.0.bandwidth.out", "o");

  return [...byTs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, e]) => ({
      server_id: server.id,
      server_name: server.name,
      ts: toIso(new Date(Math.round(t * 1000))),
      cpu_pct: normalizeCpu(e.cpu ?? null, cores),
      disk_iops: e.r == null && e.w == null ? null : (e.r ?? 0) + (e.w ?? 0),
      net_in_mbps: scale(e.i ?? null, BYTES_TO_MBIT),
      net_out_mbps: scale(e.o ?? null, BYTES_TO_MBIT),
    }));
}

export function allTimeseriesRows(servers: Server[], metricsById: Map<number, MetricsResponse | null>): Row[] {
  return finalizeRows(
    "server_timeseries",
    servers.filter((s) => s.status === "running").flatMap((s) => timeseriesRows(s, metricsById.get(s.id) ?? null)),
  );
}

// ---------------------------------------------------------------- actions

export function actionRows(actions: Action[], servers: Server[]): Row[] {
  const names = new Map(servers.map((s) => [s.id, s.name]));
  return finalizeRows(
    "recent_actions",
    actions.map((a) => {
      const serverId = a.resources?.find((r) => r.type === "server")?.id ?? null;
      return {
        id: a.id,
        command: a.command,
        status: a.status,
        progress: a.progress,
        started: isoUtc(a.started),
        finished: isoUtc(a.finished),
        server_id: serverId,
        server_name: serverId === null ? null : (names.get(serverId) ?? null),
        error_code: a.error?.code ?? null,
        error_message: a.error?.message ?? null,
      };
    }),
  );
}

// ---------------------------------------------------------------- images

export function snapshotMonthly(image: Image, pricing: Pricing | null): { net: number; gross: number } | null {
  const size = num(image.image_size);
  const net = num(pricing?.image.price_per_gb_month.net);
  const gross = num(pricing?.image.price_per_gb_month.gross);
  if (size === null || net === null || gross === null) return null;
  return { net: size * net, gross: size * gross };
}

export function imageRows(images: Image[], servers: Server[], pricing: Pricing | null, now: Date): Row[] {
  const names = new Map(servers.map((s) => [s.id, s.name]));
  return finalizeRows(
    "backups_and_snapshots",
    images
      .filter((i) => i.type === "backup" || i.type === "snapshot")
      .map((i) => {
        const serverId = i.created_from?.id ?? i.bound_to ?? null;
        return {
          id: i.id,
          type: i.type,
          description: i.description ?? null,
          server_id: serverId,
          server_name: serverId === null ? null : (names.get(serverId) ?? null),
          created: isoUtc(i.created),
          age_days: ageDays(i.created, now),
          size_gb: num(i.image_size),
          disk_size_gb: num(i.disk_size),
          status: i.status,
          protected: i.protection?.delete ?? false,
          monthly_eur: i.type === "snapshot" ? (snapshotMonthly(i, pricing)?.net ?? null) : null,
        };
      }),
  );
}

// ---------------------------------------------------------------- costs

export interface CostInputs {
  servers: Server[];
  volumes: Volume[];
  primaryIps: PrimaryIp[];
  floatingIps: FloatingIp[];
  images: Image[];
  loadBalancers: LoadBalancer[];
  pricing: Pricing;
}

type CostRow = {
  category: string; name: string; server_name: string | null;
  monthly_eur_net: number | null; monthly_eur_gross: number | null; detail: string; _id: number;
};

export function costRows(input: CostInputs): Row[] {
  const { pricing } = input;
  const serverName = new Map(input.servers.map((s) => [s.id, s.name]));
  const pct = backupPercent(pricing);
  const rows: CostRow[] = [];

  for (const s of input.servers) {
    const p = serverPrice(s, pricing);
    rows.push({
      category: "server", name: s.name, server_name: s.name, _id: s.id,
      monthly_eur_net: p?.net ?? null, monthly_eur_gross: p?.gross ?? null,
      detail: `${s.server_type.name} in ${s.location.name}`,
    });
    if (s.backup_window) {
      rows.push({
        category: "backups", name: s.name, server_name: s.name, _id: s.id,
        monthly_eur_net: p ? (p.net * pct) / 100 : null, monthly_eur_gross: p ? (p.gross * pct) / 100 : null,
        detail: `${pct}% of ${s.server_type.name} price`,
      });
    }
  }

  const volNet = num(pricing.volume.price_per_gb_month.net);
  const volGross = num(pricing.volume.price_per_gb_month.gross);
  for (const v of input.volumes) {
    rows.push({
      category: "volume", name: v.name, _id: v.id,
      server_name: v.server ? (serverName.get(v.server) ?? null) : null,
      monthly_eur_net: volNet === null ? null : v.size * volNet,
      monthly_eur_gross: volGross === null ? null : v.size * volGross,
      detail: `${v.size} GB volume in ${v.location.name}`,
    });
  }

  for (const ip of input.primaryIps) {
    const p = locationPrice(pricing.primary_ips, (e) => e.type === ip.type, ip.location.name);
    rows.push({
      category: "primary_ip", name: ip.name, _id: ip.id,
      server_name: ip.assignee_type === "server" && ip.assignee_id ? (serverName.get(ip.assignee_id) ?? null) : null,
      monthly_eur_net: p?.net ?? null, monthly_eur_gross: p?.gross ?? null,
      detail: `${ip.type} ${ip.ip} in ${ip.location.name}`,
    });
  }

  for (const ip of input.floatingIps) {
    const p = locationPrice(pricing.floating_ips, (e) => e.type === ip.type, ip.home_location.name);
    rows.push({
      category: "floating_ip", name: ip.name, _id: ip.id,
      server_name: ip.server ? (serverName.get(ip.server) ?? null) : null,
      monthly_eur_net: p?.net ?? null, monthly_eur_gross: p?.gross ?? null,
      detail: `${ip.type} ${ip.ip} in ${ip.home_location.name}`,
    });
  }

  // Backup images are covered by the per-server "backups" surcharge, so only
  // snapshots are priced per GB here.
  for (const img of input.images.filter((i) => i.type === "snapshot")) {
    const p = snapshotMonthly(img, pricing);
    const sid = img.created_from?.id;
    rows.push({
      category: "snapshot", name: img.description || `snapshot ${img.id}`, _id: img.id,
      server_name: sid ? (serverName.get(sid) ?? null) : null,
      monthly_eur_net: p?.net ?? null, monthly_eur_gross: p?.gross ?? null,
      detail: `${num(img.image_size) ?? "?"} GB snapshot`,
    });
  }

  for (const lb of input.loadBalancers) {
    const p = locationPrice(pricing.load_balancer_types, (e) => e.name === lb.load_balancer_type.name, lb.location.name);
    rows.push({
      category: "load_balancer", name: lb.name, server_name: null, _id: lb.id,
      monthly_eur_net: p?.net ?? null, monthly_eur_gross: p?.gross ?? null,
      detail: `${lb.load_balancer_type.name} in ${lb.location.name}`,
    });
  }

  return finalizeRows("cost_breakdown", uniqueNames(rows).map(({ _id, ...r }) => r));
}

/** Guarantees (category, name) uniqueness by suffixing " #<id>" on collisions. */
function uniqueNames(rows: CostRow[]): CostRow[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(`${r.category}\u0000${r.name}`, (counts.get(`${r.category}\u0000${r.name}`) ?? 0) + 1);
  return rows.map((r) => ((counts.get(`${r.category}\u0000${r.name}`) ?? 0) > 1 ? { ...r, name: `${r.name} #${r._id}` } : r));
}

// ---------------------------------------------------------------- security

function portRange(port: string | null): [number, number] {
  if (!port || port === "any") return [1, 65535];
  const [a, b] = port.split("-").map((x) => Number.parseInt(x.trim(), 10));
  return [a, Number.isFinite(b) ? b : a];
}

const openToWorld = (r: FirewallRule) => r.direction === "in" && r.source_ips.some((ip) => WORLD.has(ip.trim()));

export function securityRow(server: Server, firewallsById: Map<number, Firewall>): Record<string, unknown> {
  const applied = (server.public_net.firewalls ?? [])
    .map((f) => firewallsById.get(f.id))
    .filter((f): f is Firewall => Boolean(f));
  const base = {
    server_id: server.id,
    server_name: server.name,
    delete_protected: server.protection.delete,
    backups_enabled: Boolean(server.backup_window),
    rescue_enabled: server.rescue_enabled,
  };
  const hasFirewall = (server.public_net.firewalls?.length ?? 0) > 0;
  if (!hasFirewall) {
    return { ...base, has_firewall: false, firewall_names: "", open_inbound_ports: "all", ssh_open_to_world: true, icmp_open: true };
  }

  // Hetzner firewalls are allow-lists; with several applied, the union of
  // their rules is allowed.
  const worldRules = applied.flatMap((f) => f.rules).filter(openToWorld);
  const portRules = worldRules.filter((r) => r.protocol === "tcp" || r.protocol === "udp");
  const ranges = new Map<string, [number, number]>();
  for (const r of portRules) {
    const [a, b] = portRange(r.port);
    ranges.set(a === b ? String(a) : `${a}-${b}`, [a, b]);
  }
  const open = [...ranges.entries()].sort((x, y) => x[1][0] - y[1][0] || x[1][1] - y[1][1]).map(([k]) => k);
  const ssh = worldRules.some((r) => {
    if (r.protocol !== "tcp") return false;
    const [a, b] = portRange(r.port);
    return a <= 22 && 22 <= b;
  });

  return {
    ...base,
    has_firewall: true,
    firewall_names: applied.map((f) => f.name).join(", "),
    open_inbound_ports: open.join(", "),
    ssh_open_to_world: ssh,
    icmp_open: worldRules.some((r) => r.protocol === "icmp"),
  };
}

export function securityRows(servers: Server[], firewalls: Firewall[]): Row[] {
  const byId = new Map(firewalls.map((f) => [f.id, f]));
  return finalizeRows("security_overview", servers.map((s) => securityRow(s, byId)));
}
