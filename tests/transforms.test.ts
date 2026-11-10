import { describe, expect, it } from "vitest";
import { COLUMNS, finalizeRows, round2 } from "../src/contract";
import type {
  Action, Firewall, FloatingIp, Image, LoadBalancer, MetricsResponse, PrimaryIp, Pricing, Server, Volume,
} from "../src/hetzner/types";
import {
  actionRows, allTimeseriesRows, consoleUrl, costRows, imageRows, normalizeCpu, securityRows,
  serversToRows, usageRows,
} from "../src/transforms";
import { fixture } from "./mock-hetzner.mjs";

const NOW = new Date("2026-11-09T12:00:00Z");
const servers: Server[] = [...fixture("servers.page1").servers, ...fixture("servers.page2").servers];
const pricing: Pricing = fixture("pricing").pricing;
const firewalls: Firewall[] = fixture("firewalls").firewalls;
const images: Image[] = fixture("images").images;
const actions: Action[] = fixture("actions").actions;
const volumes: Volume[] = fixture("volumes").volumes;
const primaryIps: PrimaryIp[] = fixture("primary_ips").primary_ips;
const floatingIps: FloatingIp[] = fixture("floating_ips").floating_ips;
const loadBalancers: LoadBalancer[] = fixture("load_balancers").load_balancers;
const metrics = new Map<number, MetricsResponse | null>([
  [42, fixture("metrics.web-1")],
  [43, fixture("metrics.arm-worker")],
]);

const byName = <T extends Record<string, unknown>>(rows: T[], key: string, value: unknown) =>
  rows.find((r) => r[key] === value)!;

function expectContract(tool: keyof typeof COLUMNS, rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    expect(Object.keys(r)).toEqual([...COLUMNS[tool]]);
    for (const v of Object.values(r)) {
      expect(v === null || ["string", "number", "boolean"].includes(typeof v)).toBe(true);
      if (typeof v === "number") expect(round2(v)).toBe(v);
    }
  }
}

describe("contract helpers", () => {
  it("rounds to 2 decimals and nulls non-finite numbers", () => {
    const [row] = finalizeRows("cost_breakdown", [
      { category: "server", name: "x", server_name: null, monthly_eur_net: 1.005, monthly_eur_gross: Number.NaN, detail: "d" },
    ]);
    expect(row.monthly_eur_net).toBe(1.01);
    expect(row.monthly_eur_gross).toBeNull();
  });
  it("rejects missing, extra and non-scalar columns", () => {
    expect(() => finalizeRows("cost_breakdown", [{ category: "server" }])).toThrow(/missing column/);
    expect(() =>
      finalizeRows("cost_breakdown", [
        { category: "s", name: "n", server_name: null, monthly_eur_net: 1, monthly_eur_gross: 1, detail: "d", extra: 1 },
      ]),
    ).toThrow(/unexpected columns/);
    expect(() =>
      finalizeRows("cost_breakdown", [
        { category: "s", name: "n", server_name: null, monthly_eur_net: 1, monthly_eur_gross: 1, detail: { a: 1 } },
      ]),
    ).toThrow(/non-scalar/);
  });
});

describe("list_servers", () => {
  const rows = serversToRows(servers, pricing, { now: NOW, projectId: "123456" });

  it("matches the contract", () => {
    expect(rows).toHaveLength(3);
    expectContract("list_servers", rows);
  });

  it("maps a running server with backups, firewalls and traffic", () => {
    expect(byName(rows, "name", "web-1")).toEqual({
      id: 42, name: "web-1", status: "running", type: "cpx22", type_description: "CPX22",
      cpu_type: "shared", architecture: "x86", cores: 2, memory_gb: 4, disk_gb: 80,
      location: "fsn1", city: "Falkenstein", country: "DE", datacenter: "Falkenstein DC Park 1",
      ipv4: "1.2.3.4", ipv6: "2001:db8::/64", image: "ubuntu-24.04", os_flavor: "ubuntu",
      created: "2026-10-10T12:00:00Z", age_days: 30, backups_enabled: true, backup_window: "22-02",
      delete_protected: true, rebuild_protected: true, rescue_enabled: false, locked: false,
      firewall_count: 2, volume_count: 1, labels: '{"env":"prod","role":"web"}',
      traffic_out_gb: 2048, traffic_included_gb: 20480, traffic_used_pct: 10,
      price_monthly_eur: 7.99, backup_monthly_eur: 1.6, type_deprecated: false,
      console_url: "https://console.hetzner.com/projects/123456/servers/42/overview",
    });
  });

  it("flags per-location server type deprecation and zero backup cost", () => {
    const arm = byName(rows, "name", "arm-worker");
    expect(arm.type_deprecated).toBe(true);
    expect(arm.backup_monthly_eur).toBe(0);
    expect(arm.backups_enabled).toBe(false);
    expect(arm.traffic_used_pct).toBe(2.5);
    expect(arm.architecture).toBe("arm");
  });

  it("handles missing ipv4 and unknown traffic", () => {
    const db = byName(rows, "name", "db-1");
    expect(db.ipv4).toBeNull();
    expect(db.traffic_out_gb).toBeNull();
    expect(db.traffic_used_pct).toBeNull();
    expect(db.cpu_type).toBe("dedicated");
    expect(db.price_monthly_eur).toBe(14.49);
    expect(db.rescue_enabled).toBe(true);
  });

  it("console_url is null unless HCLOUD_PROJECT_ID is a numeric id", () => {
    expect(serversToRows(servers, pricing, { now: NOW })[0].console_url).toBeNull();
    expect(consoleUrl("abc/../x", 1)).toBeNull();
  });

  it("falls back to prices embedded in server_type when /pricing lacks the type", () => {
    const r = serversToRows(servers, { ...pricing, server_types: [] }, { now: NOW });
    expect(byName(r, "name", "web-1").price_monthly_eur).toBe(7.99);
  });
});

describe("cpu normalization", () => {
  it("divides Hetzner's per-vCPU percent by core count and clamps to 0-100", () => {
    expect(normalizeCpu(150, 2)).toBe(75);
    expect(normalizeCpu(400, 4)).toBe(100);
    expect(normalizeCpu(410, 4)).toBe(100);
    expect(normalizeCpu(null, 4)).toBeNull();
  });
});

describe("server_usage", () => {
  const rows = usageRows(servers, "1h", metrics);

  it("matches the contract", () => {
    expect(rows).toHaveLength(3);
    expectContract("server_usage", rows);
  });

  it("computes normalized cpu, disk and network stats", () => {
    expect(byName(rows, "server_name", "web-1")).toEqual({
      server_id: 42, server_name: "web-1", status: "running", window: "1h",
      cpu_now_pct: 75, cpu_avg_pct: 50, cpu_max_pct: 75,
      disk_read_iops_avg: 20, disk_write_iops_avg: 2,
      disk_read_mbps_avg: 2, disk_write_mbps_avg: 0.5,
      net_in_mbps_avg: 2, net_out_mbps_avg: 0.1,
      net_in_gb_total: round2((750000 * 60) / 1024 ** 3), net_out_gb_total: 0,
      points: 3,
    });
    const arm = byName(rows, "server_name", "arm-worker");
    expect([arm.cpu_now_pct, arm.cpu_avg_pct, arm.cpu_max_pct]).toEqual([50, 75, 100]);
  });

  it("returns null metrics for non-running servers", () => {
    const db = byName(rows, "server_name", "db-1");
    expect(db.status).toBe("off");
    for (const c of COLUMNS.server_usage.slice(4)) expect(db[c]).toBeNull();
  });

  it("returns null metrics when a running server's metrics are unavailable", () => {
    const r = usageRows(servers, "24h", new Map());
    expect(byName(r, "server_name", "web-1").cpu_avg_pct).toBeNull();
  });
});

describe("server_timeseries", () => {
  const rows = allTimeseriesRows(servers, metrics);

  it("matches the contract and only includes running servers", () => {
    expect(rows).toHaveLength(5);
    expectContract("server_timeseries", rows);
    expect(rows.some((r) => r.server_name === "db-1")).toBe(false);
  });

  it("aligns series by timestamp", () => {
    expect(rows[0]).toEqual({
      server_id: 42, server_name: "web-1", ts: "2025-11-09T09:00:00Z",
      cpu_pct: 25, disk_iops: 11, net_in_mbps: 1, net_out_mbps: 0.1,
    });
    expect(rows[2].net_out_mbps).toBeNull();
    expect(rows[3].cpu_pct).toBe(100);
  });
});

describe("recent_actions", () => {
  const rows = actionRows(actions, servers);
  it("matches the contract", () => {
    expect(rows).toHaveLength(3);
    expectContract("recent_actions", rows);
  });
  it("maps errors, server names and timestamps", () => {
    expect(rows[1]).toEqual({
      id: 12, command: "reboot_server", status: "error", progress: 100,
      started: "2026-11-08T10:00:00Z", finished: "2026-11-08T10:00:05Z",
      server_id: 42, server_name: "web-1", error_code: "action_failed", error_message: "Action failed",
    });
    expect(rows[0].finished).toBeNull();
    expect(rows[0].server_name).toBe("arm-worker");
    expect(rows[2].server_id).toBe(999);
    expect(rows[2].server_name).toBeNull();
    expect(rows[2].started).toBe("2026-11-01T08:00:00Z");
  });
});

describe("backups_and_snapshots", () => {
  const rows = imageRows(images, servers, pricing, NOW);
  it("matches the contract", () => {
    expect(rows).toHaveLength(4);
    expectContract("backups_and_snapshots", rows);
  });
  it("prices snapshots per GB and leaves backups unpriced", () => {
    expect(byName(rows, "id", 9002)).toEqual({
      id: 9002, type: "snapshot", description: "pre-upgrade", server_id: 42, server_name: "web-1",
      created: "2026-10-30T09:00:00Z", age_days: 10.13, size_gb: 4.5, disk_size_gb: 80,
      status: "available", protected: true, monthly_eur: 0.05,
    });
    expect(byName(rows, "id", 9001).monthly_eur).toBeNull();
    expect(byName(rows, "id", 9001).type).toBe("backup");
    expect(byName(rows, "id", 9003).server_name).toBeNull();
    expect(byName(rows, "id", 9003).monthly_eur).toBe(0.11);
    expect(byName(rows, "id", 9004).size_gb).toBeNull();
    expect(byName(rows, "id", 9004).monthly_eur).toBeNull();
  });
});

describe("cost_breakdown", () => {
  const rows = costRows({ servers, volumes, primaryIps, floatingIps, images, loadBalancers, pricing });

  it("matches the contract with unique (category, name)", () => {
    expectContract("cost_breakdown", rows);
    const keys = rows.map((r) => `${r.category}|${r.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows).toHaveLength(14);
  });

  it("covers every billed resource once", () => {
    const get = (c: string, n: string) => rows.find((r) => r.category === c && r.name === n)!;
    expect(get("server", "web-1")).toEqual({
      category: "server", name: "web-1", server_name: "web-1",
      monthly_eur_net: 7.99, monthly_eur_gross: 9.51, detail: "cpx22 in fsn1",
    });
    expect(get("backups", "web-1").monthly_eur_net).toBe(1.6);
    expect(get("volume", "data")).toMatchObject({ server_name: "web-1", monthly_eur_net: 1.76, detail: "40 GB volume in fsn1" });
    expect(get("volume", "orphan")).toMatchObject({ server_name: null, monthly_eur_net: 4.4 });
    expect(get("primary_ip", "primary_ip-420")).toMatchObject({ server_name: "web-1", monthly_eur_net: 0.5 });
    expect(get("primary_ip", "primary_ip-421").monthly_eur_net).toBe(0);
    expect(get("floating_ip", "web-vip")).toMatchObject({ server_name: null, monthly_eur_net: 3 });
    expect(get("snapshot", "pre-upgrade #9002")).toMatchObject({ server_name: "web-1", monthly_eur_net: 0.05 });
    expect(get("snapshot", "pre-upgrade #9003")).toMatchObject({ server_name: null, monthly_eur_net: 0.11 });
    expect(get("load_balancer", "lb-web")).toMatchObject({ monthly_eur_net: 5.39, detail: "lb11 in fsn1" });
    expect(rows.filter((r) => r.category === "backups")).toHaveLength(1);
    expect(rows.some((r) => String(r.name).includes("9001"))).toBe(false); // backup images are not double counted
  });

  it("sums to the expected monthly net total", () => {
    const total = rows.reduce((a, r) => a + ((r.monthly_eur_net as number) ?? 0), 0);
    expect(round2(total)).toBe(round2(7.99 + 6.49 + 14.49 + 1.598 + 1.76 + 4.4 + 0.5 + 0 + 0.5 + 3 + 0.0495 + 0.11 + 5.39));
  });
});

describe("security_overview", () => {
  const rows = securityRows(servers, firewalls);
  it("matches the contract", () => {
    expect(rows).toHaveLength(3);
    expectContract("security_overview", rows);
  });
  it("unions world-open inbound rules across firewalls", () => {
    expect(byName(rows, "server_name", "web-1")).toEqual({
      server_id: 42, server_name: "web-1", has_firewall: true, firewall_names: "web, wireguard",
      open_inbound_ports: "22, 80, 443, 51820-51830", ssh_open_to_world: true, icmp_open: true,
      delete_protected: true, backups_enabled: true, rescue_enabled: false,
    });
  });
  it("treats a server without firewall as fully open", () => {
    expect(byName(rows, "server_name", "arm-worker")).toMatchObject({
      has_firewall: false, firewall_names: "", open_inbound_ports: "all", ssh_open_to_world: true, icmp_open: true,
    });
  });
  it("does not count rules restricted to specific source ranges", () => {
    expect(byName(rows, "server_name", "db-1")).toMatchObject({
      has_firewall: true, firewall_names: "locked-down", open_inbound_ports: "", ssh_open_to_world: false, icmp_open: false,
    });
  });
  it("detects ssh inside a world-open tcp range", () => {
    const fw: Firewall[] = [{ id: 42, name: "wide", rules: [
      { direction: "in", protocol: "tcp", port: "1-1024", source_ips: ["::/0"], destination_ips: [] },
    ] }];
    const [r] = securityRows([servers[2]].map((s) => ({ ...s, public_net: { ...s.public_net, firewalls: [{ id: 42, status: "applied" }] } })), fw);
    expect(r.ssh_open_to_world).toBe(true);
    expect(r.open_inbound_ports).toBe("1-1024");
  });
});
