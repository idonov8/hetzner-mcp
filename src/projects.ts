// Project configuration: which Hetzner projects (tokens) this server reads.
//
//   HCLOUD_TOKENS=personal:xxx,we4water:yyy   (preferred, one read-only token per project)
//   HCLOUD_TOKEN=xxx                          (fallback, single project named "default")
//   HCLOUD_PROJECT_IDS=personal:123,we4water:456  (optional, for console_url)
//   HCLOUD_PROJECT_ID=123                     (fallback for "default")
//
// Error messages never include token values.

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export interface Project {
  name: string;
  token: string;
}

export const PROJECT_NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_PROJECT = "default";

/** Splits "a:b,c:d" into pairs, on the FIRST colon of each entry only. Empty entries are skipped. */
function pairs(raw: string): Array<{ index: number; name: string; value: string | null }> {
  return raw
    .split(",")
    .map((entry, i) => ({ entry: entry.trim(), index: i + 1 }))
    .filter(({ entry }) => entry.length > 0)
    .map(({ entry, index }) => {
      const at = entry.indexOf(":");
      return at < 0
        ? { index, name: entry, value: null }
        : { index, name: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() };
    });
}

export function parseProjects(env: Env = process.env): Project[] {
  const multi = env.HCLOUD_TOKENS?.trim();
  if (multi) {
    const projects: Project[] = [];
    for (const { index, name, value } of pairs(multi)) {
      // An entry without a colon may be a bare token pasted by mistake: never echo it.
      if (value === null) throw new ConfigError(`HCLOUD_TOKENS entry #${index}: expected name:token`);
      if (!PROJECT_NAME_RE.test(name)) {
        throw new ConfigError(`HCLOUD_TOKENS entry #${index}: project name must match ^[a-z0-9_-]{1,32}$`);
      }
      if (!value) throw new ConfigError(`HCLOUD_TOKENS entry #${index} (${name}): expected name:token`);
      if (projects.some((p) => p.name === name)) throw new ConfigError(`HCLOUD_TOKENS: duplicate project "${name}"`);
      projects.push({ name, token: value });
    }
    if (projects.length) return projects;
  }
  const single = env.HCLOUD_TOKEN?.trim();
  if (single) return [{ name: DEFAULT_PROJECT, token: single }];
  throw new ConfigError("HCLOUD_TOKENS not configured");
}

/** Console project ids by project name. Malformed entries are ignored (console_url is cosmetic). */
export function parseProjectIds(env: Env = process.env): Map<string, string> {
  const ids = new Map<string, string>();
  for (const { name, value } of pairs(env.HCLOUD_PROJECT_IDS ?? "")) {
    if (PROJECT_NAME_RE.test(name) && value && /^\d+$/.test(value)) ids.set(name, value);
  }
  const legacy = env.HCLOUD_PROJECT_ID?.trim();
  if (legacy && !ids.has(DEFAULT_PROJECT)) ids.set(DEFAULT_PROJECT, legacy);
  return ids;
}
