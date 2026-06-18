import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Adversarial read-only-member enforcement tests for authorize() (with MULTI_TENANT = 'true').
 *
 * Internal invites mint api_keys with role 'member'. A member seat is READ-ONLY: it may only
 * make GET requests. authorize() must reject any non-GET (write) request from a member key
 * BEFORE it reaches the route, while leaving admin/legacy keys (role 'admin') unaffected.
 *
 * Contracts under test:
 *   1. A member key is ALLOWED on a whitelisted GET route (it resolves to its account).
 *   2. A member key is REJECTED with 'Read-only member' on POST, PUT, and DELETE.
 *   3. An ADMIN per-account key is allowed on those same write methods (the gate is role-
 *      specific, not method-blanket).
 *   4. The legacy global key (role admin) is unaffected on writes.
 *
 * The per-account key path is exercised by mocking the ApiKey + Account models so a key with
 * role 'member' / 'admin' resolves. authorize hits whitelisted routes so the resolution +
 * role gate (not the whitelist) is what is under assertion.
 *
 * No network, no DB: database/database is a no-op and the models are jest mocks.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { findOne: jest.fn() },
}));
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOne: jest.fn() },
}));

// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import { hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockApiKey = ApiKeyModel as unknown as { findOne: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

const LEGACY_KEY = 's33k_legacy_admin_key_fixture';
const MEMBER_KEY = 's33k_member_seat_live_key_abcdefghij';
const ADMIN_KEY = 's33k_tenant_admin_live_key_abcdefghij';

// A whitelisted route for each method so the whitelist gate always passes and the role gate
// is the only thing under test. GET/POST/PUT/DELETE on /api/keywords are all whitelisted.
const KEYWORDS_URL = '/api/keywords';

const makeReq = (method: string, bearer: string, url = KEYWORDS_URL): NextApiRequest => ({
   method,
   url,
   headers: { authorization: `Bearer ${bearer}` },
} as unknown as NextApiRequest);

// resolveAccount constructs a Cookies(req, res); a no-op res surface is enough.
const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

// Set up the model mocks so MEMBER_KEY resolves to a member key on an active account, and
// ADMIN_KEY resolves to an admin key on an active account.
const wireKeys = () => {
   mockApiKey.findOne.mockImplementation(async ({ where }: { where: { key_prefix: string } }) => {
      if (where.key_prefix === apiKeyPrefix(MEMBER_KEY)) {
         return {
            ID: 60,
            account_id: 2,
            key_prefix: apiKeyPrefix(MEMBER_KEY),
            key_hash: hashApiKey(MEMBER_KEY),
            role: 'member',
            revoked_at: null,
            save: jest.fn(async () => undefined),
         };
      }
      if (where.key_prefix === apiKeyPrefix(ADMIN_KEY)) {
         return {
            ID: 61,
            account_id: 3,
            key_prefix: apiKeyPrefix(ADMIN_KEY),
            key_hash: hashApiKey(ADMIN_KEY),
            role: 'admin',
            revoked_at: null,
            save: jest.fn(async () => undefined),
         };
      }
      return null;
   });
   mockAccount.findOne.mockImplementation(async ({ where }: { where: { ID: number } }) => (
      { ID: where.ID, name: `Account ${where.ID}`, status: 'active' }
   ));
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.APIKEY = LEGACY_KEY;
   process.env.SECRET = 'unit-test-secret';
   process.env.MULTI_TENANT = 'true';
   wireKeys();
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('authorize() read-only member enforcement', () => {
   it('ALLOWS a member key on a GET request (resolves to its own account)', async () => {
      const result = await authorize(makeReq('GET', MEMBER_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account).not.toBeNull();
      expect(result.account!.ID).toBe(2);
      expect(result.role).toBe('member');
   });

   it('REJECTS a member key on POST with the read-only-member error', async () => {
      const result = await authorize(makeReq('POST', MEMBER_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Read-only member');
   });

   it('REJECTS a member key on PUT with the read-only-member error', async () => {
      const result = await authorize(makeReq('PUT', MEMBER_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Read-only member');
   });

   it('REJECTS a member key on DELETE with the read-only-member error', async () => {
      const result = await authorize(makeReq('DELETE', MEMBER_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Read-only member');
   });
});

describe('authorize() admin keys are unaffected by the member gate', () => {
   it('ALLOWS an admin per-account key on POST (the gate is role-specific, not method-blanket)', async () => {
      const result = await authorize(makeReq('POST', ADMIN_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(3);
      expect(result.role).toBe('admin');
   });

   it('ALLOWS an admin per-account key on DELETE', async () => {
      const result = await authorize(makeReq('DELETE', ADMIN_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(3);
   });

   it('ALLOWS the legacy global key (admin) on a write request', async () => {
      const result = await authorize(makeReq('POST', LEGACY_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      expect(result.role).toBe('admin');
      // The legacy key short-circuits before any per-account DB lookup.
      expect(mockApiKey.findOne).not.toHaveBeenCalled();
   });
});
