// Tiny TTL-aware in-memory cache that satisfies Baileys' CacheStore
// interface (get / set / del / flushAll). Used for msgRetryCounterCache,
// mediaCache, userDevicesCache, and cachedGroupMetadata so retries dedupe
// across reconnects and media isn't re-uploaded for every retry-receipt.
//
// No external deps — node-cache adds a real dep and a worker timer per
// instance; this one is one Map and a sweep.

export function createCache({ ttlMs = 5 * 60_000, max = 5000 } = {}) {
  const m = new Map(); // key -> { value, expiresAt }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of m) {
      if (v.expiresAt && v.expiresAt <= now) m.delete(k);
    }
  }

  return {
    get(key) {
      const e = m.get(key);
      if (!e) return undefined;
      if (e.expiresAt && e.expiresAt <= Date.now()) { m.delete(key); return undefined; }
      // LRU-ish: re-insert on read.
      m.delete(key); m.set(key, e);
      return e.value;
    },
    set(key, value) {
      if (m.size >= max) sweep();
      if (m.size >= max) {
        // Still full — evict oldest.
        const first = m.keys().next().value;
        if (first !== undefined) m.delete(first);
      }
      m.set(key, { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 });
    },
    del(key) { m.delete(key); },
    flushAll() { m.clear(); },
    size() { return m.size; },
  };
}
