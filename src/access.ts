import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_KEY_LENGTH = 32;

/**
 * Constant-time check of the secret path segment against MCP_ACCESS_KEY.
 * Both sides are hashed first so the comparison is fixed-length and leaks
 * neither content nor length. An unset or short key disables the endpoint.
 */
export function isAuthorizedKey(candidate: string | undefined, expected = process.env.MCP_ACCESS_KEY): boolean {
  if (!expected || expected.length < MIN_KEY_LENGTH) return false;
  if (typeof candidate !== "string") return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
