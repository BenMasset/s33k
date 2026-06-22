/**
 * Atomic-cap reservation tests for utils/caps-guard.ts (the count-then-create TOCTOU fix).
 *
 * The bug: two concurrent reservations each count existing = (cap - 1), both pass, both insert, and the
 * account exceeds its plan cap (the COGS lever leaks). reserveSite / reserveKeywordSlots close this by
 * counting UNDER A ROW LOCK on the account inside a transaction, so a second concurrent reservation
 * serializes behind the first and re-counts after it inserts.
 *
 * How this is tested without a real DB: we mock database/database with a connection whose transaction()
 * mimics SELECT ... FOR UPDATE by serializing all transactions through a single async mutex (the row
 * lock), and the mocked Keyword/Domain models read/write a SHARED in-memory store. So firing N concurrent
 * reservations via Promise.all genuinely contends. With the lock, exactly `cap` succeed and the store
 * NEVER exceeds the cap. We also prove (a) the flag-off / admin path is an unlimited, lock-free
 * passthrough, and (b) the degraded no-transaction path still enforces the cap.
 *
 * No network, no real DB. scope + plans run for real so the cap math and the unlimited short-circuit are
 * the genuine production logic, not re-stubbed.
 */

// A single async mutex standing in for the account-row FOR UPDATE lock. transaction() acquires it before
// running the body and releases after, so all transactions serialize, exactly like contending on one row.
let lockChain: Promise<unknown> = Promise.resolve();
const runLocked = async <T>(body: () => Promise<T>): Promise<T> => {
   const prior = lockChain;
   let release: () => void = () => {};
   lockChain = new Promise<void>((resolve) => { release = resolve; });
   await prior.catch(() => undefined);
   try {
      return await body();
   } finally {
      release();
   }
};

// The shared in-memory stores the mocked models count and append to. Concurrency races against these.
// Module-level so both the jest.mock factories (closures, evaluated lazily) and the tests can touch them.
const keywordStore: unknown[] = [];
const domainStore: unknown[] = [];

// The mock factories below are HOISTED above these declarations, so they must not reference any const at
// factory-eval time. They build the objects themselves and read the shared stores lazily (inside method
// bodies, which run after init). We grab the live mock objects back via jest.requireMock after import.
jest.mock('../../database/database', () => {
   const accountModel = { findOne: jest.fn(async () => ({ ID: 2 })) };
   return {
      __esModule: true,
      default: {
         // transaction() serializes through a single mutex, mimicking the account-row FOR UPDATE lock.
         // runLocked is a module-level const; this arrow body runs only when transaction() is called in
         // a test, by which point runLocked is initialized (the hoisting trap only bites factory-eval-
         // time references, not deferred function bodies).
         transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => runLocked(() => fn({ LOCK: { UPDATE: 'UPDATE' } }))),
         models: { Account: accountModel },
      },
   };
});
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   // count reads the shared store under the (serialized) transaction.
   default: { count: jest.fn(async () => keywordStore.length) },
}));
jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { count: jest.fn(async () => domainStore.length) },
}));

// eslint-disable-next-line import/first
import { reserveSite, reserveKeywordSlots, CapExceeded } from '../../utils/caps-guard';

// The live mocked connection (same object caps-guard imported), so tests can read its jest.fn spies and
// temporarily blank transaction() to exercise the degraded path.
const fakeConnection = (jest.requireMock('../../database/database') as { default: any }).default;
const fakeAccountModel = fakeConnection.models.Account as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

// An ACTIVE 1-site account: resolveCaps gives sites = 1, keywords = 50 (KEYWORDS_PER_SITE * 1).
const oneSiteAccount = { ID: 2, subscription_status: 'active', paid_sites: 1 } as any;

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   keywordStore.length = 0;
   domainStore.length = 0;
   lockChain = Promise.resolve();
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('reserveKeywordSlots: atomic keyword cap under concurrency', () => {
   it('lets EXACTLY the cap succeed and NEVER exceeds it when N concurrent reservations race', async () => {
      const cap = 50; // 1 site * KEYWORDS_PER_SITE
      const attempts = 70; // far more than the cap, all firing at once
      const results = await Promise.allSettled(
         Array.from({ length: attempts }, () => reserveKeywordSlots(oneSiteAccount, 1, async (t) => {
            // The insert runs inside the same (serialized) transaction the cap was checked in.
            expect(t).toBeDefined();
            keywordStore.push({});
            return 1;
         })),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected');
      // The store never grew past the cap, and exactly `cap` reservations committed an insert.
      expect(keywordStore.length).toBe(cap);
      expect(succeeded).toBe(cap);
      expect(rejected.length).toBe(attempts - cap);
      // Every rejection is the typed CapExceeded naming the keyword cap.
      rejected.forEach((r) => {
         const err = (r as PromiseRejectedResult).reason;
         expect(err).toBeInstanceOf(CapExceeded);
         expect(err.cap).toBe('keywords');
         expect(err.limit).toBe(cap);
      });
   });

   it('respects a multi-slot reservation (count = n) without overshooting the cap', async () => {
      // Pre-fill 48 of the 50, then race three 1-slot adds: exactly 2 fit.
      for (let i = 0; i < 48; i += 1) { keywordStore.push({}); }
      const results = await Promise.allSettled(
         Array.from({ length: 3 }, () => reserveKeywordSlots(oneSiteAccount, 1, async () => { keywordStore.push({}); return 1; })),
      );
      expect(keywordStore.length).toBe(50);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
   });
});

describe('reserveSite: atomic site cap under concurrency', () => {
   it('lets EXACTLY one site succeed for a 1-site account when many onboards race', async () => {
      const attempts = 25;
      const results = await Promise.allSettled(
         Array.from({ length: attempts }, () => reserveSite(oneSiteAccount, async (t) => {
            expect(t).toBeDefined();
            domainStore.push({});
            return { ID: domainStore.length };
         })),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      expect(domainStore.length).toBe(1); // never more than the 1-site cap
      expect(succeeded).toBe(1);
      results.filter((r) => r.status === 'rejected').forEach((r) => {
         const err = (r as PromiseRejectedResult).reason;
         expect(err).toBeInstanceOf(CapExceeded);
         expect(err.cap).toBe('sites');
         expect(err.limit).toBe(1);
      });
   });
});

describe('flag-off / admin: unlimited, lock-free passthrough', () => {
   it('reserveKeywordSlots never locks or counts when MULTI_TENANT is off', async () => {
      delete process.env.MULTI_TENANT;
      const created = await reserveKeywordSlots(oneSiteAccount, 1000, async (t) => {
         expect(t).toBeUndefined(); // no transaction handed to the passthrough create
         return 'ok';
      });
      expect(created).toBe('ok');
      expect(fakeConnection.transaction).not.toHaveBeenCalled();
      expect(fakeAccountModel.findOne).not.toHaveBeenCalled();
   });

   it('reserveSite never locks or counts for the admin sentinel (ID 1) even with the flag on', async () => {
      process.env.MULTI_TENANT = 'true';
      const admin = { ID: 1 } as any; // ADMIN_ACCOUNT_ID
      const created = await reserveSite(admin, async (t) => {
         expect(t).toBeUndefined();
         return { ID: 999 };
      });
      expect(created).toEqual({ ID: 999 });
      expect(fakeConnection.transaction).not.toHaveBeenCalled();
   });
});

describe('degraded path: cap still enforced when no real transaction is available', () => {
   it('enforces the keyword cap via count-then-create when connection has no transaction()', async () => {
      // Temporarily remove transaction() to force the degraded branch.
      const original = fakeConnection.transaction;
      (fakeConnection as any).transaction = undefined;
      try {
         for (let i = 0; i < 50; i += 1) { keywordStore.push({}); } // already at cap
         await expect(reserveKeywordSlots(oneSiteAccount, 1, async () => { keywordStore.push({}); return 1; }))
            .rejects.toBeInstanceOf(CapExceeded);
         expect(keywordStore.length).toBe(50); // create never ran
      } finally {
         (fakeConnection as any).transaction = original;
      }
   });
});
