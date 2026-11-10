import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WINDOWS, type Row, type Window } from "./contract";
import {
  ConfigError, HetznerApiError, getBackupAndSnapshotImages, getFirewalls, getFloatingIps,
  getLoadBalancers, getPricing, getPrimaryIps, getServerActions, getServerMetrics, getServers,
  getVolumes, mapLimit,
} from "./hetzner/client";
import type { MetricsResponse, Server } from "./hetzner/types";
import { parseProjectIds, parseProjects, type Project } from "./projects";
import {
  actionRows, allTimeseriesRows, costRows, imageRows, mergeActions, securityRows, serversToRows, usageRows,
} from "./transforms";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const METRICS_CONCURRENCY = 8;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (rows: Row[]): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ rows }) }] });

class ProjectError extends Error {}

function describe(err: unknown): string {
  return err instanceof ConfigError || err instanceof HetznerApiError || err instanceof ProjectError
    ? err.message
    : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

const fail = (err: unknown): ToolResult => ({ content: [{ type: "text", text: describe(err) }], isError: true });

/**
 * Runs fn for every configured project in parallel and concatenates the rows
 * in configuration order. If any project fails, the whole call fails with an
 * error naming that project: a silently missing project would read as
 * "no servers". Error texts never contain tokens.
 */
async function forAllProjects(source: ProjectSource, fn: (p: Project) => Promise<Row[]>): Promise<Row[]> {
  const projects = source.projects();
  const results = await Promise.all(
    projects.map((p) =>
      fn(p).catch((err: unknown) => {
        throw new ProjectError(`${p.name}: ${describe(err)}`);
      }),
    ),
  );
  return results.flat();
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
async function metricsFor(p: Project, servers: Server[], window: Window): Promise<Map<number, MetricsResponse | null>> {
  const running = servers.filter((s) => s.status === "running");
  const results = await mapLimit(running, METRICS_CONCURRENCY, async (s) => {
    try {
      return [s.id, await getServerMetrics(p, s.id, window)] as const;
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

/** Where a request's projects come from: env vars (owner URL) or a sealed URL. Both may throw ConfigError. */
export interface ProjectSource {
  projects: () => Project[];
  projectIds: () => Map<string, string>;
}

export const envProjects: ProjectSource = { projects: () => parseProjects(), projectIds: () => parseProjectIds() };

export function fixedProjects(projects: Project[]): ProjectSource {
  const ids = new Map(projects.flatMap((p) => (p.consoleId ? [[p.name, p.consoleId] as const] : [])));
  return { projects: () => projects, projectIds: () => ids };
}

export function registerTools(server: McpServer, source: ProjectSource = envProjects): void {
  const each = (fn: (p: Project) => Promise<Row[]>) => forAllProjects(source, fn);

  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description: "All servers across configured Hetzner projects with specs, location, network, protection, traffic and monthly price.",
      inputSchema: noArgs,
      annotations: READ_ONLY,
    },
    () =>
      run(() => {
        const ids = source.projectIds();
        return each(async (p) => {
          const [servers, pricing] = await Promise.all([getServers(p), getPricing(p)]);
          return serversToRows(p.name, servers, pricing, { now: new Date(), projectId: ids.get(p.name) });
        });
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
      run(() =>
        each(async (p) => {
          const servers = await getServers(p);
          return usageRows(p.name, servers, window, await metricsFor(p, servers, window));
        }),
      ),
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
      run(() =>
        each(async (p) => {
          const servers = await getServers(p);
          return allTimeseriesRows(p.name, servers, await metricsFor(p, servers, window));
        }),
      ),
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
        const rows = await each(async (p) => {
          const [actions, servers] = await Promise.all([getServerActions(p, limit), getServers(p)]);
          return actionRows(p.name, actions, servers);
        });
        return mergeActions(rows, limit);
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
      run(() =>
        each(async (p) => {
          const [images, servers, pricing] = await Promise.all([
            getBackupAndSnapshotImages(p), getServers(p), getPricing(p),
          ]);
          return imageRows(p.name, images, servers, pricing, new Date());
        }),
      ),
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
      run(() =>
        each(async (p) => {
          const [servers, volumes, primaryIps, floatingIps, images, loadBalancers, pricing] = await Promise.all([
            getServers(p), getVolumes(p), getPrimaryIps(p), getFloatingIps(p), getBackupAndSnapshotImages(p),
            getLoadBalancers(p), getPricing(p),
          ]);
          return costRows(p.name, { servers, volumes, primaryIps, floatingIps, images, loadBalancers, pricing });
        }),
      ),
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
      run(() =>
        each(async (p) => {
          const [servers, firewalls] = await Promise.all([getServers(p), getFirewalls(p)]);
          return securityRows(p.name, servers, firewalls);
        }),
      ),
  );
}
