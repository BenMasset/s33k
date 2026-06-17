/**
 * Generic, dependency-free, in-memory fixed-window rate limiter.
 *
 * This is a basic abuse brake, NOT a distributed limiter. The counters live in this single
 * process's memory, so on the single-container Railway deploy they are authoritative, but they
 * reset on restart and are NOT shared if the app is ever scaled to multiple instances. That is
 * an accepted tradeoff: the limiter exists to blunt a flood from one source, not to meter usage
 * for billing. Anything needing cross-instance accuracy must use a shared store (Redis), not this.
 *
 * Fixed window (not a sliding window) on purpose: it is the cheapest correct shape and a flood
 * is just as blocked by it. Each key holds the window start and a hit count; when the window
 * elapses the entry resets to a fresh window on the next hit.
 *
 * Unbounded growth is prevented two ways: expired entries are dropped lazily on access, and a
 * hard MAX_KEYS ceiling triggers a sweep (then, if still over, a clear) so a flood of unique
 * keys (e.g. spoofed IPs) cannot grow the map without bound.
 *
 * Nothing here throws.
 */

export type RateLimitOptions = {
   /** Max hits allowed per key within the window. */
   limit: number,
   /** Window length in milliseconds. */
   windowMs: number,
};

export type RateLimitResult = {
   /** True if this hit is within the limit; false if the window is exhausted. */
   allowed: boolean,
   /** Ms until the current window resets. 0 when allowed. */
   retryAfterMs: number,
};

type Bucket = { windowStart: number, count: number };

// One shared map for all callers. Keys are caller-namespaced strings (e.g. `collect:1.2.3.4`),
// so distinct limiters never collide even though they share the map.
const buckets = new Map<string, Bucket>();

// Hard ceiling on tracked keys so a unique-key flood (spoofed IPs) cannot grow memory unbounded.
const MAX_KEYS = 50000;

// Drop every entry whose window has already elapsed relative to `now`. Cheap O(n) sweep, only run
// when the map crosses MAX_KEYS, so the steady-state hot path stays O(1).
const evictExpired = (now: number): void => {
   for (const [key, bucket] of buckets) {
      // A bucket is dead once a full window has elapsed since its start; window length is not
      // stored per bucket, so use the largest plausible window guard: drop anything older than
      // the entry could possibly still be counting. We approximate with the bucket's own age vs
      // a generous ceiling; callers use minute-scale windows, so 1h of staleness is safely dead.
      if (now - bucket.windowStart >= 3600 * 1000) { buckets.delete(key); }
   }
   // If the sweep did not free enough (pathological burst of fresh unique keys), hard-reset.
   if (buckets.size > MAX_KEYS) { buckets.clear(); }
};

/**
 * Account one hit against `key` and report whether it is allowed.
 * @param {string} key - Caller-namespaced bucket key (e.g. `collect:<ip>`).
 * @param {RateLimitOptions} options - limit (max hits) and windowMs (window length).
 * @param {number} [now] - Current epoch ms; injectable for deterministic tests.
 * @returns {RateLimitResult} allowed + retryAfterMs.
 */
export const rateLimit = (key: string, options: RateLimitOptions, now = Date.now()): RateLimitResult => {
   const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 1;
   const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 1000;

   const existing = buckets.get(key);

   // New key or elapsed window: start a fresh window counting this hit as the first.
   if (!existing || (now - existing.windowStart) >= windowMs) {
      if (buckets.size >= MAX_KEYS) { evictExpired(now); }
      buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
   }

   if (existing.count >= limit) {
      // Window exhausted. Report time remaining so the caller can set Retry-After.
      const retryAfterMs = Math.max(0, windowMs - (now - existing.windowStart));
      return { allowed: false, retryAfterMs };
   }

   existing.count += 1;
   return { allowed: true, retryAfterMs: 0 };
};

/** Test-only: clear all in-memory rate-limit state. */
export const __resetGenericRateLimit = (): void => { buckets.clear(); };
