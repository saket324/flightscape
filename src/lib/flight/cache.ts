/**
 * A small in-process TTL cache.
 *
 * Used for data that genuinely does not change minute to minute: airline
 * names, airport coordinates, the route a callsign flies.
 *
 * Live positions are deliberately NOT cached anywhere in this codebase. A
 * cached coordinate served as the current one is precisely the failure this
 * product cannot have, so the cache is kept away from the position path
 * entirely rather than guarded with a short TTL.
 */

type Entry<T> = {
  value: T;
  expiresAtMs: number;
};

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAtMs <= now) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh insertion order so the eviction below is least-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAtMs: now + this.ttlMs });
  }

  /** Fetch through the cache, storing whatever the loader resolves to. */
  async fetch(key: string, loader: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.get(key, now);
    if (cached !== undefined) return cached;

    const value = await loader();
    this.set(key, value, now);
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
