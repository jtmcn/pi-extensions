/**
 * Three properties this cache must have, each of which prevents a specific
 * failure: eviction (unbounded growth), negative entries (respawning delta
 * forever on a failure), and in-flight tracking (one process per diff, not one
 * per repaint).
 *
 *   node tests/delta/cache.test.mjs
 */

import { assertions, loadExt } from "../harness.mjs";

const { ok, done } = assertions();
const { createCache, cacheKey } = await loadExt("delta/cache.ts");

const key = (n) => cacheKey(`diff ${n}`, 80, "v1");

ok("key is stable", key(1) === key(1));
ok("key varies with text", key(1) !== key(2));
ok("key varies with width", cacheKey("d", 80, "v1") !== cacheKey("d", 100, "v1"));
ok("key varies with config version", cacheKey("d", 80, "v1") !== cacheKey("d", 80, "v2"));

const cache = createCache(3);
cache.set(key(1), { kind: "ready", text: "one" });
cache.set(key(2), { kind: "ready", text: "two" });
cache.set(key(3), { kind: "ready", text: "three" });
ok("stores up to the limit", cache.size() === 3);
ok("returns what was stored", cache.get(key(2))?.text === "two");

// key(2) was just read, so key(1) is now the least recently used.
cache.set(key(4), { kind: "ready", text: "four" });
ok("evicts to the limit", cache.size() === 3, String(cache.size()));
ok("evicts least recently used", cache.get(key(1)) === undefined);
ok("keeps recently read entry", cache.get(key(2))?.text === "two");

// Diverging-order scenario: access the insertion-order oldest last so that
// insertion order and recency diverge. Without LRU promotion the broken
// implementation would evict key(1) (oldest insertion); the correct
// implementation evicts key(2) (true LRU).
const cache2 = createCache(3);
cache2.set(key(1), { kind: "ready", text: "one" });
cache2.set(key(2), { kind: "ready", text: "two" });
cache2.set(key(3), { kind: "ready", text: "three" });
cache2.get(key(1)); // promote the insertion-order oldest to most-recently-used
cache2.set(key(4), { kind: "ready", text: "four" }); // forces one eviction
ok("get promotes to most recently used", cache2.get(key(1))?.text === "one");
ok("evicts true LRU, not insertion order", cache2.get(key(2)) === undefined);

cache2.set(key(5), { kind: "failed" });
ok("negative entry is retrievable", cache2.get(key(5))?.kind === "failed");

ok("nothing in flight initially", cache2.inFlight(key(6)) === false);
cache2.markInFlight(key(6));
ok("in flight after marking", cache2.inFlight(key(6)) === true);
cache2.clearInFlight(key(6));
ok("not in flight after clearing", cache2.inFlight(key(6)) === false);

cache2.markInFlight(key(7));
cache2.reset();
ok("reset clears entries", cache2.size() === 0);
ok("reset clears in-flight", cache2.inFlight(key(7)) === false);

done();
