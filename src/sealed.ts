// Sealed MCP URLs: the project list (names + read-only tokens) is encrypted
// with AES-256-GCM under SEAL_SECRET and carried in the URL path. Nothing is
// stored server-side; the URL itself is the credential. GCM authenticates the
// payload, so a tampered or foreign blob fails to open and the route 404s.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PROJECT_NAME_RE, type Project } from "./projects";

export const MIN_SECRET_LENGTH = 32;
export const MAX_PROJECTS = 10;
export const MAX_SEALED_LENGTH = 4096;
export const TOKEN_RE = /^[\x21-\x7e]{1,256}$/;
const CONSOLE_ID_RE = /^\d{1,20}$/;

const VERSION = "v1";
const PREFIX = `${VERSION}.`;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SealError extends Error {}

function deriveKey(secret: string | undefined): Buffer | null {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return createHash("sha256").update(`hetzner-mcp/seal/${VERSION}\u0000${secret}`, "utf8").digest();
}

export const sealingEnabled = (secret = process.env.SEAL_SECRET) => deriveKey(secret) !== null;

/** Throws SealError with a message that never contains a token. */
export function validateProjects(projects: Project[]): void {
  if (projects.length === 0) throw new SealError("Add at least one project");
  if (projects.length > MAX_PROJECTS) throw new SealError(`At most ${MAX_PROJECTS} projects per URL`);
  const seen = new Set<string>();
  projects.forEach((p, i) => {
    const label = `Project #${i + 1}`;
    if (!PROJECT_NAME_RE.test(p.name)) throw new SealError(`${label}: name must be 1-32 chars of a-z, 0-9, _ or -`);
    if (seen.has(p.name)) throw new SealError(`Duplicate project name "${p.name}"`);
    seen.add(p.name);
    if (!TOKEN_RE.test(p.token)) throw new SealError(`${p.name}: token looks malformed`);
    if (p.consoleId !== undefined && !CONSOLE_ID_RE.test(p.consoleId)) {
      throw new SealError(`${p.name}: console project id must be a number`);
    }
  });
}

type Wire = { p: Array<[string, string] | [string, string, string]> };

export function seal(projects: Project[], secret = process.env.SEAL_SECRET): string {
  const key = deriveKey(secret);
  if (!key) throw new SealError("Sealing is not configured on this server");
  validateProjects(projects);
  const wire: Wire = { p: projects.map((p) => (p.consoleId ? [p.name, p.token, p.consoleId] : [p.name, p.token])) };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(PREFIX));
  const ct = Buffer.concat([cipher.update(JSON.stringify(wire), "utf8"), cipher.final()]);
  const sealed = PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
  if (sealed.length > MAX_SEALED_LENGTH) throw new SealError("Too much data for one URL");
  return sealed;
}

/** Returns null for anything that is not a valid blob sealed under this secret. */
export function unseal(sealed: string | undefined, secret = process.env.SEAL_SECRET): Project[] | null {
  const key = deriveKey(secret);
  if (!key || typeof sealed !== "string" || sealed.length > MAX_SEALED_LENGTH || !sealed.startsWith(PREFIX)) {
    return null;
  }
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(PREFIX));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const wire = JSON.parse(plain.toString("utf8")) as Wire;
    if (!Array.isArray(wire?.p)) return null;
    const projects: Project[] = wire.p.map((e) => {
      if (!Array.isArray(e) || typeof e[0] !== "string" || typeof e[1] !== "string") throw new SealError("bad entry");
      return typeof e[2] === "string" ? { name: e[0], token: e[1], consoleId: e[2] } : { name: e[0], token: e[1] };
    });
    validateProjects(projects);
    return projects;
  } catch {
    return null;
  }
}
