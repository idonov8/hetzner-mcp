# Hetzner MCP (read-only)

A small remote MCP server that gives Claude a **read-only** view of one or more Hetzner Cloud projects (e.g. `personal` and `we4water`): servers, usage metrics, recent actions, backups/snapshots, monthly costs and firewall exposure. It runs as a Next.js route on Vercel (Streamable HTTP, stateless). You add it to claude.ai as a custom connector named **Hetzner**.

- Endpoint: `https://<your-domain>/mcp/<MCP_ACCESS_KEY>`. Any other path, or a wrong key, returns 404.
- It only uses `GET` calls against the Hetzner Cloud API. It has no tools that change anything.
- Every tool queries **all configured projects in parallel** and returns their rows together. The first column of every row, `project`, holds the configured project name.
- If any project fails (bad token, 401/403/429...), the whole call fails with an error that names the project, e.g. `we4water: Hetzner API 401 unauthorized ...`. A project that silently went missing would look like "no servers".
- Responses are cached in memory per project (30 s for lists and pricing, 60 s for metrics) to stay under Hetzner's 3600 requests/hour limit, which applies per project.

## Tools

Each tool returns one text item containing JSON `{"rows":[...]}`. Every row is a flat object of scalars, and its first column is `project`. Numbers are rounded to 2 decimals and timestamps are ISO 8601 UTC.

| Tool | Args | One row per |
|---|---|---|
| `list_servers` | none | server: specs, location, IPs, image, protection, traffic, monthly price, type deprecation, console link |
| `server_usage` | `window`: `1h` \| `24h` \| `7d` \| `30d` (default `24h`) | server: CPU now/avg/max, disk IOPS and MB/s, network Mbit/s and GB totals (null if not running) |
| `server_timeseries` | `window` (same) | data point of a running server: `ts`, `cpu_pct`, `disk_iops`, `net_in_mbps`, `net_out_mbps` |
| `recent_actions` | `limit`: 1-100 (default 50) | server action, newest first across all projects (the limit applies to the merged list) |
| `backups_and_snapshots` | none | backup or snapshot image, with size, age and monthly snapshot cost |
| `cost_breakdown` | none | billed item: server, backups, volume, primary_ip, floating_ip, snapshot, load_balancer; (`project`, `category`, `name`) is unique |
| `security_overview` | none | server: firewalls, ports open to the world, SSH/ICMP exposure, protection flags |

The exact column lists are in [`src/contract.ts`](src/contract.ts).

### Units and conventions

- **CPU**: Hetzner reports CPU as a percentage per vCPU (100 = one full vCPU, so a 4-vCPU server goes up to 400). All `cpu_*` values here are divided by the core count, so they are 0-100 % of the whole machine.
- **Network**: Mbit/s (`bytes/s × 8 / 10^6`). **Disk throughput**: MB/s (`bytes/s / 10^6`).
- **GB values that come from byte counts** (traffic, `net_*_gb_total`) use 1024³, like Hetzner's own traffic accounting (20 TB included = 20480 GB).
- **Prices**: EUR per month. `*_eur` and `monthly_eur_net` are net prices. `monthly_eur_gross` includes VAT as returned by `GET /pricing`.
- **Metric steps**: 1h = 60 s, 24h = 600 s, 7d = 3600 s, 30d = 14400 s.
- `datacenter`: Hetzner removed `server.datacenter` from the API on 2026-07-01. This column now holds the location description, for example "Falkenstein DC Park 1".

## Configuration

| Variable | Required | Format |
|---|---|---|
| `HCLOUD_TOKENS` | yes (or `HCLOUD_TOKEN`) | Comma-separated `name:token` pairs, e.g. `personal:xxx,we4water:yyy`. Names must match `^[a-z0-9_-]{1,32}$`. Each entry is split on its first colon only. |
| `MCP_ACCESS_KEY` | yes | Random secret, at least 32 characters: `openssl rand -hex 24`. If it is unset or too short, every request returns 404. |
| `HCLOUD_PROJECT_IDS` | no | `name:id` pairs, e.g. `personal:123456,we4water:654321`. The id is the number in the console URL (`console.hetzner.com/projects/<id>/...`). Enables `console_url` in `list_servers`. |
| `HCLOUD_TOKEN` | legacy | Used only when `HCLOUD_TOKENS` is unset. It becomes a single project named `default`. |
| `HCLOUD_PROJECT_ID` | legacy | Console id for the `default` project. |

If no token is configured, tools return the error `HCLOUD_TOKENS not configured`. Configuration errors never echo token values.

## Deploy (about 5 minutes)

1. **Create a read-only token in EACH Hetzner project.** Hetzner tokens are scoped to one project. For each project (e.g. `personal`, `we4water`): Hetzner Console → project → **Security** → **API tokens** → **Generate API token**. Choose permission **Read**, not Read & Write. Copy each token.
2. **Deploy to Vercel.** Do either of these:
   - From this folder: `npm i -g vercel`, then `vercel deploy --prod`. Accept the detected Next.js settings.
   - Or push the folder to a **private** GitHub repo, then import it at vercel.com/new.
3. **Set the environment variables** (Vercel → Project → Settings → Environment Variables, Production). Then redeploy.
   - `HCLOUD_TOKENS` = `personal:<personal token>,we4water:<we4water token>`
   - `MCP_ACCESS_KEY` = output of `openssl rand -hex 24`
   - `HCLOUD_PROJECT_IDS` (optional) = `personal:<id>,we4water:<id>`
4. **Add the connector to Claude.** claude.ai → **Settings** → **Connectors** → **Add custom connector**. Name it `Hetzner` and set the URL to `https://<your-vercel-domain>/mcp/<MCP_ACCESS_KEY>`. Leave OAuth empty.

To add a project later: create its read-only token, append `,name:token` to `HCLOUD_TOKENS`, and redeploy. To rotate the key: change `MCP_ACCESS_KEY`, redeploy, then update the connector URL. To revoke a project's access: delete its token in the Hetzner Console. Until you also remove it from `HCLOUD_TOKENS`, every tool call fails with that project's 401.

## Security

- **Read-only tokens.** Even if the URL or a token leaked, nobody could change, stop or delete anything through it. Hetzner enforces each token's Read permission on its side. Each token only sees its own project.
- **Secret URL.** The access key in the path is the only authentication, the same model as a secret webhook URL. It is compared in constant time. Wrong keys get a plain 404, so the endpoint doesn't reveal that it exists. Treat the full URL like a password.
- **What someone with the URL could see:** everything the seven tools return, for **every configured project**. That includes server names, public IPs, labels, specs, locations, usage metrics, recent action history, backup/snapshot metadata, monthly costs, and which ports are open to the internet. The last one is useful reconnaissance for an attacker. They could **not** read the Hetzner token, SSH keys, passwords, disk contents or private-network data, and they could not change anything.
- **Logs.** The app never logs the tokens or the key. Vercel's own request logs do record request paths, which include the key, and only members of your Vercel team can see them.
- **Token safety.** Configuration and API error messages never include token values. `HCLOUD_API_URL` can only redirect API calls to `127.0.0.1` or `localhost` (used by the local smoke test). A misconfiguration can't send your token to another host.

## Development

```bash
npm install
npm test           # unit tests for every transform (fixtures in tests/fixtures, shaped like the Hetzner API docs)
npm run build
npm run smoke      # runs `next start` against a local fake Hetzner API with two fake projects and exercises MCP end to end
npm run test:all   # typecheck + unit + build + smoke
```

To run it locally against your real project, put the variables from `.env.example` into `.env.local` and run `npm run dev`. Then use `http://localhost:3000/mcp/<MCP_ACCESS_KEY>`.

Stack: Next.js App Router (`app/mcp/[key]/route.ts`), [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) 2.x with `@modelcontextprotocol/server` 2.x and zod 4. This handler serves the current MCP spec and falls back to 2025-era stateless Streamable HTTP.
