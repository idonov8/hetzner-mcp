import { createMcpHandler } from "mcp-handler";
import { isAuthorizedKey, notFound } from "../../../src/access";
import { registerTools } from "../../../src/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcp = createMcpHandler(registerTools, {
  serverInfo: { name: "hetzner", version: "1.0.0" },
  instructions:
    "Read-only view of one or more Hetzner Cloud projects. Every tool returns one JSON text item shaped {\"rows\":[...]} of flat scalar rows; the first column, project, names the Hetzner project.",
  verboseLogs: false,
});

type Ctx = { params: Promise<{ key: string }> };

async function guarded(req: Request, ctx: Ctx): Promise<Response> {
  const { key } = await ctx.params;
  if (!isAuthorizedKey(key)) return notFound();
  return mcp(req);
}

async function options(req: Request, ctx: Ctx): Promise<Response> {
  const { key } = await ctx.params;
  if (!isAuthorizedKey(key)) return notFound();
  return new Response(null, { status: 204, headers: { allow: "GET, POST, DELETE, OPTIONS" } });
}

export { guarded as GET, guarded as POST, guarded as DELETE, options as OPTIONS };
