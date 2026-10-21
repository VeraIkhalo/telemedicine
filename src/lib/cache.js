// Small TTL cache (cache-aside). In production swap for Redis behind the same interface
// so all API replicas share it; the interface (get/set/delByPrefix) stays the same.
const { cacheHits } = require('../observability/metrics');

function createCache({ ttlMs = 30000, maxEntries = 5000 } = {}) {
  const store = new Map();

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit || hit.expires < Date.now()) {
        store.delete(key);
        cacheHits.inc({ result: 'miss' });
        return undefined;
      }
      cacheHits.inc({ result: 'hit' });
      return hit.value;
    },
    set(key, value, ttl = ttlMs) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value); // evict oldest
      store.set(key, { value, expires: Date.now() + ttl });
    },
    delByPrefix(prefix) {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    clear: () => store.clear(),
  };
}

module.exports = { createCache };
