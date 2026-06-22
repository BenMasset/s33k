/**
 * Postgres-backed (and SQLite-capable) fixed-window rate-limit store: the SHARED-STORE backend for
 * utils/rate-limit.ts. It exists so a rate limit holds across MULTIPLE app instances. The in-memory
 * limiter is per process, so under horizontal scaling an effective limit L becomes L*N, and the most
 * safety-critical brake (the per-EMAIL magic-link cap, 3/hour) degrades to 3*N links to a victim's
 * inbox. A single shared row per key fixes that: every instance reads and mutates the SAME counter.
 *
 * One round trip per check. The whole "is the window elapsed? reset or increment, then tell me the
 * resulting count and window start" decision happens inside ONE atomic UPSERT:
 *
 *   INSERT ... VALUES (key, now, 1)
 *   ON CONFLICT ("key") DO UPDATE SET
 *     count        = CASE WHEN (now - rate_limit.window_start) >= windowMs THEN 1   ELSE rate_limit.count + 1 END,
 *     window_start = CASE WHEN (now - rate_limit.window_start) >= windowMs THEN now ELSE rate_limit.window_start END
 *   RETURNING count, window_start
 *
 * Because the read (current row) and the write (reset-or-increment) are the same statement, two
 * instances racing the same key cannot both see a fresh window: the database serializes the UPSERT,
 * so the counts are exact regardless of concurrency. This is the property the in-memory limiter
 * cannot give across processes. The ON CONFLICT ("key") DO UPDATE ... RETURNING form is supported by
 * BOTH Postgres and the bundled SQLite (3.35+), so one statement serves both dialects and the
 * cross-instance test can run on SQLite.
 *
 * "key" is a SQL reserved word, so it is ALWAYS quoted in the statement. Column names byte-match
 * database/models/rateLimit.ts and the create-rate-limit-table migration (Postgres is case-sensitive).
 *
 * The exported function has the SAME effective contract as utils/rate-limit.ts rateLimit() except it
 * is ASYNC (the round trip): (key, options, now?) -> Promise<RateLimitResult>. rate-limit.ts awaits it
 * when RATE_LIMIT_BACKEND='postgres', so all call sites inherit it through the same rateLimit() name.
 *
 * FAIL-OPEN on a store error. If the DB round trip throws (DB briefly unreachable), we ALLOW the hit
 * rather than 500 the request. A rate limiter is an abuse brake, not an auth control: failing it
 * closed would let a transient DB blip lock every user out of login, which is worse than briefly
 * un-braked. The real controls (token entropy, single-use, short TTL) hold regardless. We log so the
 * operator sees a degraded limiter.
 */

import { QueryTypes } from 'sequelize';
import connection from '../database/database';

// Mirror utils/rate-limit.ts's exported shapes so call sites and the rateLimit() delegate are identical.
export type RateLimitStoreOptions = {
   /** Max hits allowed per key within the window. */
   limit: number,
   /** Window length in milliseconds. */
   windowMs: number,
};

export type RateLimitStoreResult = {
   /** True if this hit is within the limit; false if the window is exhausted. */
   allowed: boolean,
   /** Ms until the current window resets. 0 when allowed. */
   retryAfterMs: number,
};

// The reserved key under which the global all-keys ceiling counts in the SAME shared table when the
// backend is postgres. Namespaced with a control prefix that no caller key can collide with (caller
// keys are 'auth-req-ip:...', 'mcp:...', etc., never starting with this sentinel).
export const GLOBAL_CEILING_KEY = '__s33k_global_ceiling__';

// Read the global all-keys ceiling from env on each call (same contract as the memory path), so an
// operator/tests can tune it without a rebuild. <= 0 disables it.
const globalMaxHitsPerWindow = (): number => {
   const raw = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX || '', 10);
   return Number.isFinite(raw) && raw >= 0 ? raw : 100000;
};

// The atomic UPSERT, WITHOUT a RETURNING clause. The reset-or-increment decision lives entirely in
// the ON CONFLICT ("key") DO UPDATE clause, so the row mutation is one serialized statement no matter
// how many instances race the key (this is the cross-instance correctness property). Bind params (in
// order): key, now, now, windowMs, now, windowMs, now. The repeated now/windowMs feed the two CASE
// expressions plus the reset value; positional binds keep it dialect-portable (Postgres and SQLite
// both accept ? with the `replacements` array form). "key" is a reserved word, always quoted.
const UPSERT_BASE = 'INSERT INTO rate_limit ("key", window_start, count) VALUES (?, ?, 1) '
   + 'ON CONFLICT ("key") DO UPDATE SET '
   + 'count = CASE WHEN (? - rate_limit.window_start) >= ? THEN 1 ELSE rate_limit.count + 1 END, '
   + 'window_start = CASE WHEN (? - rate_limit.window_start) >= ? THEN ? ELSE rate_limit.window_start END';

// Read back the resulting counter for a key after the UPSERT.
const SELECT_ROW = 'SELECT count, window_start FROM rate_limit WHERE "key" = ?';

const isPostgres = (): boolean => connection.getDialect() === 'postgres';

// One atomic upsert + read for `key`. Returns the resulting count and the window start it belongs to.
//
// DIALECT split (do not "simplify" back to one statement, it does not work on both):
//   - POSTGRES (prod): append RETURNING count, window_start and run as ONE statement / ONE round trip.
//     Sequelize surfaces the RETURNING rows for an INSERT under QueryTypes.SELECT on Postgres.
//   - SQLITE (local/test): Sequelize's SQLite dialect does NOT surface RETURNING rows for an INSERT
//     (it routes the statement by verb and the SELECT-type result mapper throws on it). So we run the
//     UPSERT as RAW, then a follow-up SELECT. This is two statements, but it is still CORRECT: the
//     UPSERT's increment/reset is atomic; the SELECT only reads the committed value. A concurrent
//     bump landing between the two would make us read a slightly HIGHER count, which can only reject
//     EARLIER, never over-allow. A rate limiter erring toward blocking is the safe direction. SQLite
//     is single-writer locally anyway, so the interleave is theoretical there.
// BIGINT comes back as a string on Postgres (pg maps int8 to string to avoid precision loss), so
// window_start (and count, defensively) are coerced with Number() before any arithmetic.
const bumpKey = async (key: string, windowMs: number, now: number): Promise<{ count: number, windowStart: number }> => {
   const upsertParams = [key, now, now, windowMs, now, windowMs, now];
   if (isPostgres()) {
      const rows = await connection.query(`${UPSERT_BASE} RETURNING count, window_start`, {
         replacements: upsertParams,
         type: QueryTypes.SELECT,
      }) as Array<{ count: number | string, window_start: number | string }>;
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : { count: 1, window_start: now };
      return { count: Number(row.count), windowStart: Number(row.window_start) };
   }
   await connection.query(UPSERT_BASE, { replacements: upsertParams, type: QueryTypes.RAW });
   const rows = await connection.query(SELECT_ROW, {
      replacements: [key],
      type: QueryTypes.SELECT,
   }) as Array<{ count: number | string, window_start: number | string }>;
   const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : { count: 1, window_start: now };
   return { count: Number(row.count), windowStart: Number(row.window_start) };
};

/**
 * Account one hit against `key` in the SHARED store and report whether it is allowed. Same effective
 * contract as utils/rate-limit.ts rateLimit(), but async (one DB round trip). The global all-keys
 * ceiling is enforced FIRST under GLOBAL_CEILING_KEY (matching the memory path's order), so a
 * unique-key flood is bounded in the shared store too.
 * @param {string} key - Caller-namespaced bucket key (e.g. 'auth-req-email:<email>').
 * @param {RateLimitStoreOptions} options - limit (max hits) and windowMs (window length).
 * @param {number} [now] - Current epoch ms; injectable for deterministic tests.
 * @returns {Promise<RateLimitStoreResult>} allowed + retryAfterMs.
 */
export const rateLimitStore = async (
   key: string,
   options: RateLimitStoreOptions,
   now = Date.now(),
): Promise<RateLimitStoreResult> => {
   const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 1;
   const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 1000;

   try {
      // Global all-keys ceiling FIRST: a unique-key flood passes every per-key check but still bumps
      // this shared sentinel counter, so the aggregate is bounded no matter how many keys are spoofed.
      // Disabled when the ceiling is <= 0.
      const globalMax = globalMaxHitsPerWindow();
      if (globalMax > 0) {
         const g = await bumpKey(GLOBAL_CEILING_KEY, windowMs, now);
         if (g.count > globalMax) {
            return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - g.windowStart)) };
         }
      }

      const { count, windowStart } = await bumpKey(key, windowMs, now);
      if (count > limit) {
         return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - windowStart)) };
      }
      return { allowed: true, retryAfterMs: 0 };
   } catch (error) {
      // FAIL-OPEN: a store error must not lock users out. Allow the hit; log for the operator.
      console.log('[WARN] Shared-store rate limit unavailable, allowing this hit: ', error);
      return { allowed: true, retryAfterMs: 0 };
   }
};

// Test-only: delete every shared-store counter (per-key rows and the global ceiling). Best-effort.
export const __resetStoreRateLimit = async (): Promise<void> => {
   try {
      await connection.query('DELETE FROM rate_limit', { type: QueryTypes.DELETE });
   } catch (error) {
      // Table may not exist yet in a test that never synced; ignore.
   }
};
