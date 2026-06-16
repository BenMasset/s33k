import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Adversarial tenant-resolution tests for authorize() + the per-account key path of
 * resolveAccount() (with MULTI_TENANT = 'true').
 *
 * The pure resolveAccount.test.ts deliberately skips the DB-backed per-account key path
 * (legacy key / cookie / flag-off only). This suite covers exactly that gap by mocking
 * the ApiKey + Account models, proving the multi-tenant key seam:
 *   1. A valid tenant Bearer key resolves to THAT tenant's account (not admin), only when
 *      its key_hash matches and the account is active.
 *   2. The legacy global process.env.APIKEY still resolves to the admin account even with
 *      the flag on (back-compat promise).
 *   3. A REVOKED key is rejected (the lookup excludes revoked_at != null; the row is gone,
 *      so authorize returns unauthorized).
 *   4. An UNKNOWN key (no matching prefix row) is rejected.
 *   5. A key whose stored hash does NOT match the presented key is rejected (prefix
 *      collision / forged key cannot impersonate a tenant).
 *   6. A key pointing at a SUSPENDED (non-active) account is rejected.
 *
 * authorize() also enforces the route whitelist on Bearer callers; we hit a whitelisted
 * route (GET /api/domains) so the resolution result is what is under test, not the gate.
 *
 * No network, no DB: database/database is a no-op and the models are jest mocks.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));

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
const TENANT_KEY = 's33k_tenant_two_live_key_abcdefghij';

// authorize hits a whitelisted GET route so the whitelist gate passes and the
// resolution outcome (which account) is the thing under assertion.
const makeReq = (bearer?: string): NextApiRequest => ({
   method: 'GET',
   url: '/api/domains',
   headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
} as unknown as NextApiRequest);

// resolveAccount constructs a Cookies(req, res); the no-op res surface is enough.
const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.APIKEY = LEGACY_KEY;
   process.env.SECRET = 'unit-test-secret';
   process.env.MULTI_TENANT = 'true';
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('authorize() per-tenant key resolution (MULTI_TENANT on)', () => {
   it('resolves a valid tenant Bearer key to THAT tenant account, not admin', async () => {
      const tenant = { ID: 2, name: 'Tenant Two', status: 'active' };
      mockApiKey.findOne.mockResolvedValue({
         ID: 50,
         account_id: 2,
         key_prefix: apiKeyPrefix(TENANT_KEY),
         key_hash: hashApiKey(TENANT_KEY),
         revoked_at: null,
         save: jest.fn(async () => undefined),
      });
      mockAccount.findOne.mockResolvedValue(tenant);

      const result = await authorize(makeReq(TENANT_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account).not.toBeNull();
      expect(result.account!.ID).toBe(2);
      expect(result.account!.ID).not.toBe(ADMIN_ACCOUNT_ID);
      // The lookup must filter out revoked keys.
      expect(mockApiKey.findOne.mock.calls[0][0].where).toMatchObject({ revoked_at: null });
   });

   it('STILL resolves the legacy global key to the admin account with the flag on', async () => {
      const result = await authorize(makeReq(LEGACY_KEY), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      // The legacy key short-circuits before any per-account DB lookup.
      expect(mockApiKey.findOne).not.toHaveBeenCalled();
   });

   it('rejects a REVOKED key (no live row returned by the revoked_at: null lookup)', async () => {
      // The route excludes revoked keys in the query, so a revoked key yields no row.
      mockApiKey.findOne.mockResolvedValue(null);

      const result = await authorize(makeReq(TENANT_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Invalid API Key Provided.');
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });

   it('rejects an UNKNOWN key (no matching prefix row)', async () => {
      mockApiKey.findOne.mockResolvedValue(null);

      const result = await authorize(makeReq('s33k_unknown_never_minted_key'), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Invalid API Key Provided.');
   });

   it('rejects a forged key whose stored hash does not match (prefix collision)', async () => {
      // A row exists for the prefix, but the stored hash belongs to a DIFFERENT secret.
      mockApiKey.findOne.mockResolvedValue({
         ID: 51,
         account_id: 2,
         key_prefix: apiKeyPrefix(TENANT_KEY),
         key_hash: hashApiKey('s33k_some_other_real_key_value_here'),
         revoked_at: null,
         save: jest.fn(async () => undefined),
      });

      const result = await authorize(makeReq(TENANT_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      // Hash mismatch must never reach the account lookup.
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });

   it('rejects a valid key pointing at a SUSPENDED (non-active) account', async () => {
      mockApiKey.findOne.mockResolvedValue({
         ID: 52,
         account_id: 9,
         key_prefix: apiKeyPrefix(TENANT_KEY),
         key_hash: hashApiKey(TENANT_KEY),
         revoked_at: null,
         save: jest.fn(async () => undefined),
      });
      mockAccount.findOne.mockResolvedValue({ ID: 9, name: 'Suspended Co', status: 'suspended' });

      const result = await authorize(makeReq(TENANT_KEY), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
   });
});
