import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Adversarial enforcement tests for the per-domain SHARE key in authorize() (MULTI_TENANT on).
 *
 * A share key is a read-only api_key minted on the domain OWNER's account with scoped_domain set
 * to the one domain it may read. authorize() applies the ONLY new enforcement centrally, after
 * account resolution:
 *   1. READ-ONLY regardless of role: any non-GET is rejected ('Read-only member').
 *   2. The request MUST target that exact domain: req.query.domain must equal scoped_domain, else
 *      403-shaped rejection ('This key is limited to <domain>.'). A missing domain param (the
 *      no-domain routes: portfolio, domains list, account, me) is therefore denied automatically,
 *      and so is any OTHER domain.
 *
 * The per-account key path is exercised by mocking the ApiKey + Account models so a key with
 * scoped_domain resolves. This pins the genuine end-to-end gate (resolve -> enforce). When in
 * doubt the gate DENIES, so these tests pin both the allow and the many deny paths.
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
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockApiKey = ApiKeyModel as unknown as { findOne: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

const SHARE_KEY = 's33k_share_key_for_example_dot_com_abc';
const SCOPED_DOMAIN = 'example.com';

const makeReq = (method: string, url: string, query: Record<string, string> = {}): NextApiRequest => ({
   method,
   url,
   query,
   headers: { authorization: `Bearer ${SHARE_KEY}` },
} as unknown as NextApiRequest);

const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

// The share key resolves to a member role with scoped_domain set, on an active account.
const wireShareKey = () => {
   mockApiKey.findOne.mockImplementation(async ({ where }: { where: { key_prefix: string } }) => {
      if (where.key_prefix === apiKeyPrefix(SHARE_KEY)) {
         return {
            ID: 80,
            account_id: 2,
            key_prefix: apiKeyPrefix(SHARE_KEY),
            key_hash: hashApiKey(SHARE_KEY),
            role: 'member',
            scoped_domain: SCOPED_DOMAIN,
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
   process.env.SECRET = 'unit-test-secret';
   process.env.MULTI_TENANT = 'true';
   wireShareKey();
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('authorize() per-domain share-key enforcement', () => {
   it('ALLOWS a GET that targets the scoped domain exactly', async () => {
      const result = await authorize(makeReq('GET', '/api/scoreboard', { domain: SCOPED_DOMAIN }), makeRes());

      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(2);
      expect(result.role).toBe('member');
      expect(result.scopedDomain).toBe(SCOPED_DOMAIN);
   });

   it('REJECTS a GET that targets a DIFFERENT domain', async () => {
      const result = await authorize(makeReq('GET', '/api/scoreboard', { domain: 'other.com' }), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe(`This key is limited to ${SCOPED_DOMAIN}.`);
   });

   it('REJECTS a GET on a NO-DOMAIN route (not in the scoped-key allowlist)', async () => {
      // Portfolio/domains/account/me are NOT per-domain-gated, so they are excluded from the
      // scoped-key allowlist. The allowlist check runs before the domain-equality check, so the
      // denial reason is the route rejection (this route now denies even WITH a ?domain= present,
      // which is the whole point of the positive-allowlist fix).
      const result = await authorize(makeReq('GET', '/api/portfolio', {}), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('This Route cannot be accessed with a share key.');
   });

   it.each(['POST', 'PUT', 'DELETE'])('REJECTS a %s even when it targets the scoped domain (read-only)', async (method) => {
      const result = await authorize(makeReq(method, '/api/keywords', { domain: SCOPED_DOMAIN }), makeRes());

      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe('Read-only member');
   });
});
