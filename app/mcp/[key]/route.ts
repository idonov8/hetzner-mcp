import { createMcpHandler } from "mcp-handler";
import { isAuthorizedKey, notFound } from "../../../src/access";
import { unseal } from "../../../src/sealed";
import { envProjects, fixedProjects, registerTools, type ProjectSource } from "../../../src/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPTIONS = {
  serverInfo: { name: "hetzner", version: "1.1.0" },
  instructions:
    "Read-only view of one or more Hetzner Cloud projects. Every tool returns one JSON text item shaped {\"rows\":[...]} of flat scalar rows; the first column, project, names the Hetzner project.",
  verboseLogs: false,
};

const make = (source: ProjectSource) => createMcpHandler((server) => registerTools(server, source), OPTIONS);
const ownerHandler = make(envProjects);

type Ctx = { params: Promise<{ key: string }> };

/**
 * The path segment is either the owner's MCP_ACCESS_KEY (projects from env
 * vars) or a sealed blob carrying its own projects. Transport is stateless,
 * so a sealed request gets its own short-lived handler.
 */
async function resolve(ctx: Ctx): Promise<((req: Request) => Promise<Response>) | null> {
  const { key } = await ctx.params;
  if (isAuthorizedKey(key)) return ownerHandler;
  const projects = unseal(key);
  return projects ? make(fixedProjects(projects)) : null;
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const handler = await resolve(ctx);
  return handler ? handler(req) : notFound();
}

async function options(_req: Request, ctx: Ctx): Promise<Response> {
  if (!(await resolve(ctx))) return notFound();
  return new Response(null, { status: 204, headers: { allow: "GET, POST, DELETE, OPTIONS" } });
}

export { handle as GET, handle as POST, handle as DELETE, options as OPTIONS };
