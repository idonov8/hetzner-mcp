// The tool contract. A dashboard is built against these exact names and
// column orders, so treat every change here as a breaking change.
// Every row starts with "project": the configured Hetzner project name.

export const WINDOWS = ["1h", "24h", "7d", "30d"] as const;
export type Window = (typeof WINDOWS)[number];

/** Window length in seconds and the metrics step used for it. */
export const WINDOW_SPEC: Record<Window, { seconds: number; step: number }> = {
  "1h": { seconds: 3600, step: 60 },
  "24h": { seconds: 86400, step: 600 },
  "7d": { seconds: 7 * 86400, step: 3600 },
  "30d": { seconds: 30 * 86400, step: 14400 },
};

export const COLUMNS = {
  list_servers: [
    "project", "id", "name", "status", "type", "type_description", "cpu_type", "architecture",
    "cores", "memory_gb", "disk_gb", "location", "city", "country", "datacenter",
    "ipv4", "ipv6", "image", "os_flavor", "created", "age_days", "backups_enabled",
    "backup_window", "delete_protected", "rebuild_protected", "rescue_enabled", "locked",
    "firewall_count", "volume_count", "labels", "traffic_out_gb", "traffic_included_gb",
    "traffic_used_pct", "price_monthly_eur", "backup_monthly_eur", "type_deprecated",
    "console_url",
  ],
  server_usage: [
    "project", "server_id", "server_name", "status", "window", "cpu_now_pct", "cpu_avg_pct",
    "cpu_max_pct", "disk_read_iops_avg", "disk_write_iops_avg", "disk_read_mbps_avg",
    "disk_write_mbps_avg", "net_in_mbps_avg", "net_out_mbps_avg", "net_in_gb_total",
    "net_out_gb_total", "points",
  ],
  server_timeseries: [
    "project", "server_id", "server_name", "ts", "cpu_pct", "disk_iops", "net_in_mbps", "net_out_mbps",
  ],
  recent_actions: [
    "project", "id", "command", "status", "progress", "started", "finished", "server_id",
    "server_name", "error_code", "error_message",
  ],
  backups_and_snapshots: [
    "project", "id", "type", "description", "server_id", "server_name", "created", "age_days",
    "size_gb", "disk_size_gb", "status", "protected", "monthly_eur",
  ],
  cost_breakdown: [
    "project", "category", "name", "server_name", "monthly_eur_net", "monthly_eur_gross", "detail",
  ],
  security_overview: [
    "project", "server_id", "server_name", "has_firewall", "firewall_names", "open_inbound_ports",
    "ssh_open_to_world", "icmp_open", "delete_protected", "backups_enabled", "rescue_enabled",
  ],
} as const;

export type ToolName = keyof typeof COLUMNS;
export type Scalar = number | string | boolean | null;
export type Row = Record<string, Scalar>;

/**
 * Rounds every number to 2 decimals, maps undefined/NaN/Infinity to null,
 * and emits keys in the contract order. Throws if a column is missing or a
 * value is not a scalar, so contract drift fails loudly in tests.
 */
export function finalizeRows(tool: ToolName, rows: Array<Record<string, unknown>>): Row[] {
  const cols = COLUMNS[tool] as readonly string[];
  return rows.map((r) => {
    const extra = Object.keys(r).filter((k) => !cols.includes(k));
    if (extra.length) throw new Error(`${tool}: unexpected columns ${extra.join(",")}`);
    const out: Row = {};
    for (const c of cols) {
      if (!(c in r)) throw new Error(`${tool}: missing column ${c}`);
      out[c] = toScalar(r[c], `${tool}.${c}`);
    }
    return out;
  });
}

function toScalar(v: unknown, where: string): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? round2(v) : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  throw new Error(`${where}: non-scalar value`);
}

export function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
