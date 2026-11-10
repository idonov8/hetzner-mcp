import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WINDOWS, type Row, type Window } from "./contract";
import {
  ConfigError, HetznerApiError, getBackupAndSnapshotImages, getFirewalls, getFloatingIps,
  getLoadBalancers, getPricing, getPrimaryIps, getServerActions, getServerMetrics, getServers,
  getVolumes, mapLimit,
} from "./hetzner/client";
import type { MetricsResponse, Server } from "./hetzner/types";
import {
  actionRows, allTimeseriesRows, costRows, imageRows, securityRows, serversToRows, usageRows,
} from "./transforms";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const METRICS_CONCURRENCY = 8;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (rows: Row[]): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ rows }) }] });

function fail(err: unknown): ToolResult {
  const message =
    err instanceof ConfigError || err instanceof HetznerApiError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<Row[]>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Fetches metrics for all running servers in parallel. A per-server failure
 * yields null metrics for that server, except auth/rate-limit/config errors,
 * which abort the whole call.
 */
async function metricsFor(servers: Server[], window: Window): Promise<Map<number, MetricsResponse | null>> {
  const running = servers.filter((s) => s.status === "running");
  const results = await mapLimit(running, METRICS_CONCURRENCY, async (s) => {
    try {
      return [s.id, await getServerMetrics(s.id, window)] as const;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      if (err instanceof HetznerApiError && [401, 403, 429].includes(err.status)) throw err;
      return [s.id, null] as const;
    }
  });
  return new Map(results);
}

const windowArg = z.object({
  window: z.enum(WINDOWS).default("24h").describe("Time window: 1h, 24h, 7d or 30d"),
});
const noArgs = z.object({});

export function registerTools(server: McpServer): void {
  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description: "All Hetzner Cloud servers with specs, location, network, protection, traffic and monthly price.",
      inputSchema: noArgs,
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const [servers, pricing] = await Promise.all([getServers(), getPricing()]);
        return serversToRows(servers, pricing, { now: new Date(), projectId: process.env.HCLOUD_PROJECT_ID });
      }),
  );

  server.registerTool(
    "server_usage",
    {
      title: "Server usage",
      description: "Per-server CPU (0-100% of whole machine), disk and network averages over a window.",
      inputSchema: windowArg,
      annotations: READ_ONLY,
    },
    ({ window }) =>
      run(async () => {
        const servers = await getServers();
        return usageRows(servers, window, await metricsFor(servers, window));
      }),
  );

  server.registerTool(
    "server_timeseries",
    {
      title: "Server time series",
      description: "CPU, disk IOPS and network time series for running servers over a window.",
      inputSchema: windowArg,
      annotations: READ_ONLY,
    },
    ({ window }) =>
      run(async () => {
        const servers = await getServers();
        return allTimeseriesRows(servers, await metricsFor(servers, window));
      }),
  );

  server.registerTool(
    "recent_actions",
    {
      title: "Recent server actions",
      description: "Most recent server actions (reboots, rebuilds, backups...), newest first.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(50).describe("Number of actions, 1-100"),
      }),
      annotations: READ_ONLY,
    },
    ({ limit }) =>
      run(async () => {
        const [actions, servers] = await Promise.all([getServerActions(limit), getServers()]);
        return actionRows(actions, servers);
      }),
  );

  server.registerTool(
    "backups_and_snapshots",
    {
      title: "Backups and snapshots",
      description: "Backup and snapshot images with source server, size, age and monthly snapshot cost.",
      inputSchema: noArgs,
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const [images, servers, pricing] = await Promise.all([getBackupAndSnapshotImages(), getServers(), getPricing()]);
        return imageRows(images, servers, pricing, new Date());
      }),
  );

  server.registerTool(
    "cost_breakdown",
    {
      title: "Cost breakdown",
      description: "Monthly cost of every billed resource (servers, backups, volumes, IPs, snapshots, load balancers).",
      inputSchema: noArgs,
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const [servers, volumes, primaryIps, floatingIps, images, loadBalancers, pricing] = await Promise.all([
          getServers(), getVolumes(), getPrimaryIps(), getFloatingIps(), getBackupAndSnapshotImages(),
          getLoadBalancers(), getPricing(),
        ]);
        return costRows({ servers, volumes, primaryIps, floatingIps, images, loadBalancers, pricing });
      }),
  );

  server.registerTool(
    "security_overview",
    {
      title: "Security overview",
      description: "Per-server firewall coverage, ports open to the world, SSH/ICMP exposure and protection flags.",
      inputSchema: noArgs,
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const [servers, firewalls] = await Promise.all([getServers(), getFirewalls()]);
        return securityRows(servers, firewalls);
      }),
  );
}
