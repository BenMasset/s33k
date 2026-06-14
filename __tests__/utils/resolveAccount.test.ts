import type { NextApiRequest, NextApiResponse } from 'next';
import jwt from 'jsonwebtoken';

// Mock the sequelize-typescript model modules so importing the resolver does NOT pull in
// the real sequelize ESM chain (which jest cannot transform here) and never opens a DB
// connection. The legacy-key, cookie-session, and MULTI_TENANT-off branches under test
// never call these model methods, so the stubs are never invoked; they exist only to
// keep this a pure, network-free, DB-free unit test. findOne throws so that if the code
// ever fell through to the DB path in these tests, the test would fail loudly instead of
// silently hitting a real model.
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOne: jest.fn(async () => { throw new Error('DB should not be hit in pure resolver tests'); }) },
}));
jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { findOne: jest.fn(async () => { throw new Error('DB should not be hit in pure resolver tests'); }) },
}));

// eslint-disable-next-line import/first
import resolveAccount, { hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

/**
 * Pure unit tests for the multi-tenant accounts resolver (utils/resolveAccount.ts).
 *
 * The resolver is the seam that turns a Bearer key (or cookie session) into an Account.
 * The two invariants this suite locks down:
 *   1. The legacy global process.env.APIKEY ALWAYS resolves to the default/admin
 *      account (ID = ADMIN_ACCOUNT_ID), whether MULTI_TENANT is off or on. This is the
 *      back-compat promise: the single shared key keeps working forever.
 *   2. The admin account is the "NULL owner" default. A resolved admin account carries
 *      ID = ADMIN_ACCOUNT_ID, which the scope helpers (utils/scope.ts, covered in
 *      scope.test.ts) treat as the unscoped, NULL-owner_id legacy tenant.
 *
 * No network, no DB. The legacy-key and cookie-session branches return an in-memory
 * admin sentinel and never call a model method, so these paths are fully pure. The
 * MULTI_TENANT-off "wrong key" / "no key" branches likewise short-circuit before any DB
 * lookup. We deliberately do NOT exercise the per-account api_key DB lookup here (that
 * path requires the sequelize models to be connected); it is out of scope for a pure
 * unit test.
 */

const ORIGINAL_ENV = { ...process.env };

const LEGACY_KEY = 's33k_legacy_admin_key_fixture';

// Minimal NextApiRequest stand-in carrying just an Authorization header and cookie jar.
const makeReq = (opts: { bearer?: string, cookie?: string } = {}): NextApiRequest => {
   const headers: Record<string, string> = {};
   if (opts.bearer !== undefined) { headers.authorization = `Bearer ${opts.bearer}`; }
   if (opts.cookie !== undefined) { headers.cookie = `token=${opts.cookie}`; }
   return { headers } as unknown as NextApiRequest;
};

// The `cookies` library reads/writes via res; a no-op res with the needed surface is enough.
const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

describe('resolveAccount', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.APIKEY = LEGACY_KEY;
      process.env.SECRET = 'unit-test-secret';
      delete process.env.MULTI_TENANT;
   });

   afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
   });

   describe('legacy global APIKEY resolves to the default/admin account', () => {
      it('resolves the legacy key to the admin account when MULTI_TENANT is off', async () => {
         const result = await resolveAccount(makeReq({ bearer: LEGACY_KEY }), makeRes());
         expect(result.authorized).toBe(true);
         expect(result.account).not.toBeNull();
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
         expect(result.error).toBeUndefined();
      });

      it('STILL resolves the legacy key to the admin account when MULTI_TENANT is on', async () => {
         process.env.MULTI_TENANT = 'true';
         const result = await resolveAccount(makeReq({ bearer: LEGACY_KEY }), makeRes());
         expect(result.authorized).toBe(true);
         expect(result.account).not.toBeNull();
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      });

      it('resolves the admin account without any DB lookup (in-memory sentinel)', async () => {
         // The admin sentinel is a bare { ID } object: it has no sequelize instance
         // methods like save/reload. Asserting that proves the legacy path never
         // touched the api_key/account tables.
         const result = await resolveAccount(makeReq({ bearer: LEGACY_KEY }), makeRes());
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
         expect((result.account as unknown as { save?: unknown }).save).toBeUndefined();
      });
   });

   describe('cookie session resolves to the admin account (wave 1: no users table)', () => {
      it('resolves a valid JWT cookie to the admin account', async () => {
         const token = jwt.sign({ user: 'admin' }, process.env.SECRET as string);
         const result = await resolveAccount(makeReq({ cookie: token }), makeRes());
         expect(result.authorized).toBe(true);
         expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      });

      it('does not authorize an invalid JWT cookie', async () => {
         const result = await resolveAccount(makeReq({ cookie: 'not-a-real-jwt' }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
      });
   });

   describe('unauthorized paths (MULTI_TENANT off)', () => {
      it('rejects a wrong Bearer key with the legacy invalid-key error', async () => {
         const result = await resolveAccount(makeReq({ bearer: 'totally-wrong-key' }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Invalid API Key Provided.');
      });

      it('rejects a request with no key and no cookie', async () => {
         const result = await resolveAccount(makeReq(), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Not authorized');
      });
   });
});

describe('resolveAccount pure key helpers', () => {
   describe('hashApiKey', () => {
      it('produces a stable 64-char hex SHA-256 digest', () => {
         const hash = hashApiKey('s33k_abcdef');
         expect(hash).toMatch(/^[0-9a-f]{64}$/);
         expect(hashApiKey('s33k_abcdef')).toBe(hash);
      });

      it('produces different digests for different keys', () => {
         expect(hashApiKey('s33k_one')).not.toBe(hashApiKey('s33k_two'));
      });

      it('never stores the clear key inside the hash', () => {
         const clear = 's33k_super_secret_value';
         expect(hashApiKey(clear)).not.toContain(clear);
      });
   });

   describe('apiKeyPrefix', () => {
      it('returns the first 12 characters for indexed lookup', () => {
         expect(apiKeyPrefix('s33k_abcdef1234567890')).toBe('s33k_abcdef1');
         expect(apiKeyPrefix('s33k_abcdef1234567890')).toHaveLength(12);
      });

      it('returns the whole string when shorter than the prefix length', () => {
         expect(apiKeyPrefix('s33k_ab')).toBe('s33k_ab');
      });
   });
});
