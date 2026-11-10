import { HetznerApiError, getServers } from "../../../src/hetzner/client";
import type { Project } from "../../../src/projects";
import { MAX_PROJECTS, SealError, seal, sealingEnabled, validateProjects } from "../../../src/sealed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 16_384;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (status: number, error: string) => json(status, { error });

function parseBody(raw: string): Project[] {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new SealError("Request body must be JSON");
  }
  const list = (body as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) throw new SealError("Expected {\"projects\": [...]}");
  if (list.length > MAX_PROJECTS) throw new SealError(`At most ${MAX_PROJECTS} projects per URL`);
  return list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const consoleId = str(o.consoleId);
    return { name: str(o.name).toLowerCase(), token: str(o.token), ...(consoleId ? { consoleId } : {}) };
  });
}

/** One GET per project (cached, so it warms the first tool call), so a typo shows up here and not inside Claude. */
async function verify(p: Project): Promise<void> {
  try {
    await getServers(p);
  } catch (err) {
    if (err instanceof HetznerApiError) {
      if (err.status === 401) throw new SealError(`${p.name}: Hetzner rejected this token`);
      if (err.status === 403) throw new SealError(`${p.name}: token cannot read servers`);
      if (err.status === 429) throw new SealError(`${p.name}: Hetzner rate limit hit, try again in a minute`);
    }
    throw new SealError(`${p.name}: could not reach the Hetzner API`);
  }
}

/** Next rewrites req.url to localhost, so take the public origin from the forwarded headers. */
function publicOrigin(req: Request): string {
  const fallback = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? fallback.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? fallback.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export async function POST(req: Request): Promise<Response> {
  if (!sealingEnabled()) return fail(503, "Sealing is not configured on this server");
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "Request too large");
  try {
    const projects = parseBody(raw);
    validateProjects(projects);
    await Promise.all(projects.map(verify));
    const url = `${publicOrigin(req)}/mcp/${seal(projects)}`;
    return json(200, { url, projects: projects.map((p) => p.name) });
  } catch (err) {
    return fail(400, err instanceof SealError ? err.message : "Something went wrong");
  }
}
