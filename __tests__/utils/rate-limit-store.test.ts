/**
 * Tests for utils/rate-limit-store.ts: the Postgres-backed (SQLite-capable) SHARED-STORE fixed-window
 * limiter that backs utils/rate-limit.ts when RATE_LIMIT_BACKEND='postgres'.
 *
 * The headline invariant is CROSS-INSTANCE enforcement: the counter lives in the DB, NOT in process
 * memory, so a limit holds across multiple app instances. We prove it by giving the store TWO separate
 * connection objects (instanceA and instanceB) that talk to the SAME underlying sqlite3 database
 * handle. That is a faithful stand-in for two processes behind a load balancer: instanceA's hits and
 * instanceB's hits share one counter row, so their COMBINED hits cannot exceed the limit in one
 * window. The per-EMAIL 3/hour variant is the brake that degrades worst under horizontal scaling
 * (3*N), so it gets its own cross-instance assertion.
 *
 * The store only uses connection.query(sql, opts) and connection.getDialect(), so we back those two
 * methods with a real in-memory sqlite3 DB rather than loading real Sequelize (whose ESM uuid
 * dependency jest cannot transform, the documented reason DB tests in this repo mock the connection).
 * The SQL the store runs is exercised against a real SQLite engine, so the UPSERT, the reset logic,
 * and the cross-instance sharing are all genuinely tested.
 */

import sqlite3 from 'sqlite3';

// QueryTypes is the only sequelize value the store imports; stub it so importing the store does not
// pull in real sequelize (the ESM-uuid transform problem). The store passes these as the `type`
// option, which our fake connection inspects to decide between a row-returning and a no-rows query.
jest.mock('sequelize', () => ({
   __esModule: true,
   QueryTypes: { SELECT: 'SELECT', RAW: 'RAW', DELETE: 'DELETE' },
}));

// ONE shared in-memory sqlite3 DB, created per test in beforeEach. Two fake connections point at it,
// so the two "instances" genuinely share one database.
let sharedDb: sqlite3.Database;

// Run a parameterized query against the shared sqlite3 handle. For SELECT we resolve to the rows
// array (matching Sequelize's QueryTypes.SELECT shape the store expects); otherwise we run() it.
const runQuery = (sql: string, opts?: { replacements?: unknown[], type?: string }): Promise<unknown> => new Promise((resolve, reject) => {
   const params = (opts && opts.replacements) || [];
   const type = opts && opts.type;
   if (type === 'SELECT') {
      sharedDb.all(sql, params as never[], (err, rows) => (err ? reject(err) : resolve(rows)));
      return;
   }
   sharedDb.run(sql, params as never[], (err) => (err ? reject(err) : resolve(undefined)));
});

// A minimal connection that satisfies the store's surface: query() + getDialect(). Dialect is sqlite
// so the store takes its two-statement (UPSERT then SELECT) path, the one the test engine supports.
const fakeConnection = () => ({
   query: (sql: string, opts?: { replacements?: unknown[], type?: string }) => runQuery(sql, opts),
   getDialect: () => 'sqlite',
   default: undefined as never,
});

// Mock the database module the store imports. `default` is the connection; we hand a fresh fake per
// require so two loadInstance() calls produce two distinct connection objects over the same sqlite3 DB.
jest.mock('../../database/database', () => ({
   __esModule: true,
   get default() { return fakeConnection(); },
   ensureSynced: jest.fn(async () => undefined),
}));

// Load a FRESH copy of the store. isolateModules gives each a distinct module instance (distinct
// connection object via the getter above), modeling an independent app instance on the shared DB.
const loadInstance = () => {
   let mod: typeof import('../../utils/rate-limit-store');
   jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      mod = require('../../utils/rate-limit-store');
   });
   return { store: mod!.rateLimitStore };
};

// Create the rate_limit table (idempotent), matching the create-rate-limit-table migration's column
// shape exactly. Column names byte-match the migration. Done per test so each test starts clean.
const ensureTable = (): Promise<void> => new Promise((resolve, reject) => {
   sharedDb.run(
      'CREATE TABLE IF NOT EXISTS rate_limit ("key" TEXT PRIMARY KEY, window_start BIGINT NOT NULL, count INTEGER NOT NULL)',
      (err) => (err ? reject(err) : resolve()),
   );
});

beforeEach(() => {
   sharedDb = new sqlite3.Database(':memory:');
   delete process.env.DATABASE_URL;
   // Disable the global all-keys ceiling by default so per-key assertions are not perturbed by it.
   process.env.RATE_LIMIT_GLOBAL_MAX = '0';
});

afterEach((done) => {
   delete process.env.RATE_LIMIT_GLOBAL_MAX;
   sharedDb.close(() => done());
});

describe('rateLimitStore single-instance window', () => {
   it('allows up to the limit then rejects, with a retry-after on rejection', async () => {
      await ensureTable();
      const { store } = loadInstance();
      const now = 1_000_000;
      const opts = { limit: 3, windowMs: 60_000 };
      expect((await store('k:a', opts, now)).allowed).toBe(true);
      expect((await store('k:a', opts, now + 1)).allowed).toBe(true);
      expect((await store('k:a', opts, now + 2)).allowed).toBe(true);
      const fourth = await store('k:a', opts, now + 3);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterMs).toBeGreaterThan(0);
   });

   it('resets after the window elapses', async () => {
      await ensureTable();
      const { store } = loadInstance();
      const now = 2_000_000;
      const opts = { limit: 1, windowMs: 60_000 };
      expect((await store('k:b', opts, now)).allowed).toBe(true);
      expect((await store('k:b', opts, now + 1)).allowed).toBe(false);
      // Past the window: the row resets to a fresh window of 1, so the next hit is allowed again.
      expect((await store('k:b', opts, now + 60_001)).allowed).toBe(true);
   });

   it('keeps distinct keys independent', async () => {
      await ensureTable();
      const { store } = loadInstance();
      const now = 3_000_000;
      const opts = { limit: 1, windowMs: 60_000 };
      expect((await store('k:c', opts, now)).allowed).toBe(true);
      expect((await store('k:d', opts, now)).allowed).toBe(true);
   });
});

describe('rateLimitStore CROSS-INSTANCE enforcement (the point of the shared store)', () => {
   it('caps COMBINED hits from two instances at the limit within one window', async () => {
      await ensureTable();
      // Two store instances with two distinct connection objects over ONE sqlite3 DB = two "instances".
      const a = loadInstance();
      const b = loadInstance();

      const now = 4_000_000;
      const opts = { limit: 4, windowMs: 60_000 };

      // Interleave hits across both instances. Exactly `limit` (4) total are allowed; the 5th, no
      // matter which instance serves it, is rejected because both read the SAME shared counter row.
      expect((await a.store('shared:ip', opts, now)).allowed).toBe(true); // 1 (A)
      expect((await b.store('shared:ip', opts, now + 1)).allowed).toBe(true); // 2 (B)
      expect((await a.store('shared:ip', opts, now + 2)).allowed).toBe(true); // 3 (A)
      expect((await b.store('shared:ip', opts, now + 3)).allowed).toBe(true); // 4 (B)
      // 5th hit from EITHER instance is over the shared limit.
      expect((await a.store('shared:ip', opts, now + 4)).allowed).toBe(false);
      expect((await b.store('shared:ip', opts, now + 5)).allowed).toBe(false);
   });

   it('holds the per-EMAIL 3/hour cap across both instances (the worst-degrading brake)', async () => {
      await ensureTable();
      const a = loadInstance();
      const b = loadInstance();

      const now = 5_000_000;
      // The production magic-link per-email brake: 3 links per email per hour.
      const opts = { limit: 3, windowMs: 60 * 60 * 1000 };
      const key = 'auth-req-email:victim@example.com';

      // Three links allowed total, spread across the two instances.
      expect((await a.store(key, opts, now)).allowed).toBe(true); // 1
      expect((await b.store(key, opts, now + 1)).allowed).toBe(true); // 2
      expect((await a.store(key, opts, now + 2)).allowed).toBe(true); // 3
      // The 4th request to flood the victim's inbox is blocked even though it hits the OTHER instance.
      const flood = await b.store(key, opts, now + 3);
      expect(flood.allowed).toBe(false);
      expect(flood.retryAfterMs).toBeGreaterThan(0);
   });
});

describe('rateLimitStore global all-keys ceiling (shared-store, spoofed-key flood defense)', () => {
   it('bounds total hits across UNIQUE keys regardless of per-key limits, across instances', async () => {
      process.env.RATE_LIMIT_GLOBAL_MAX = '5';
      await ensureTable();
      const a = loadInstance();
      const b = loadInstance();

      const now = 6_000_000;
      const opts = { limit: 1000, windowMs: 60_000 };
      // Five unique-key hits split across both instances all pass their own per-key check, but the
      // SHARED global counter caps the aggregate at 5.
      for (let i = 0; i < 5; i += 1) {
         const inst = i % 2 === 0 ? a : b;
         // eslint-disable-next-line no-await-in-loop
         expect((await inst.store(`flood:${i}`, opts, now + i)).allowed).toBe(true);
      }
      const overflow = await a.store('flood:6', opts, now + 6);
      expect(overflow.allowed).toBe(false);
      expect(overflow.retryAfterMs).toBeGreaterThan(0);
   });

   it('is disabled when RATE_LIMIT_GLOBAL_MAX is 0', async () => {
      process.env.RATE_LIMIT_GLOBAL_MAX = '0';
      await ensureTable();
      const { store } = loadInstance();
      const now = 7_000_000;
      const opts = { limit: 1000, windowMs: 60_000 };
      for (let i = 0; i < 30; i += 1) {
         // eslint-disable-next-line no-await-in-loop
         expect((await store(`nolimit:${i}`, opts, now + i)).allowed).toBe(true);
      }
   });
});

describe('rateLimitStore fails open on a store error', () => {
   it('allows the hit when the rate_limit table does not exist (no table created)', async () => {
      // No ensureTable(): the rate_limit table is absent, so the UPSERT throws. The limiter must
      // FAIL OPEN (allow) rather than lock users out on a transient DB problem.
      const { store } = loadInstance();
      const opts = { limit: 1, windowMs: 60_000 };
      const res = await store('nosync:key', opts, 8_000_000);
      expect(res.allowed).toBe(true);
      expect(res.retryAfterMs).toBe(0);
   });
});
