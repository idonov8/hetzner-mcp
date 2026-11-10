// Tiny in-memory TTL cache. On Vercel it lives as long as a warm function
// instance, which is enough to absorb dashboard refresh bursts and keep us
// well under Hetzner's 3600 requests/hour limit. Promises are cached so
// concurrent callers share one upstream request; failures are not cached.

type Entry = { expires: number; value: Promise<unknown> };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

export const TTL = {
  list: 30_000,
  metrics: 60_000,
} as const;

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;

  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) if (e.expires <= now) store.delete(k);
    if (store.size >= MAX_ENTRIES) store.clear();
  }

  const value = load();
  store.set(key, { expires: now + ttlMs, value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

export function clearCache(): void {
  store.clear();
}
