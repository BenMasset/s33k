/**
 * Adversarial tests for the DATA EXPORT route (pages/api/export.ts).
 *
 * SECURITY-CRITICAL contract under test (with MULTI_TENANT = 'true'):
 *   1. TENANT-SCOPED. A real tenant's export only ever contains the caller's OWN data:
 *      domains are read with { owner_id: tenant.ID }; keywords and events are read with
 *      BOTH owner_id AND a domain-IN filter restricted to the caller's own domain names.
 *      A second tenant's domains, keywords, and events are never returned.
 *   2. NO SECRETS EVER LEAVE. The encrypted Search Console blob on a domain is stripped to
 *      a boolean (search_console_configured); api keys are emitted as metadata only and the
 *      key_hash is NEVER present anywhere in the response.
 *   3. The bundle is shaped as advertised (counts match, accountId echoed).
 *
 * The DB layer is mocked to a no-op sync, every tenant-owned model is mocked so each call
 * is a pure assertion on the where-clause the route built, sequelize Op is stubbed (the
 * route imports it directly), and authorize is mocked per-test to inject the caller. The
 * real scopeWhere is threaded through so the test proves the end-to-end scoping contract.
 * No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// export.ts imports { Op } from 'sequelize'. Stub it so jest never transforms sequelize's
// ESM deps; the models are mocked, so Op.in is only a stable unique key in the where-clauses.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/invite', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/featureRequest', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import { Op } from 'sequelize';
// eslint-disable-next-line import/first
import exportHandler from '../../pages/api/export';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import InviteModel from '../../database/models/invite';
// eslint-disable-next-line import/first
import FeatureRequestModel from '../../database/models/featureRequest';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };
const mockApiKey = ApiKeyModel as unknown as { findAll: jest.Mock };
const mockInvite = InviteModel as unknown as { findAll: jest.Mock };
const mockFeatureRequest = FeatureRequestModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

// A plain stand-in for a sequelize row: get({plain}) returns a flat object.
const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // Sensible defaults so every query returns empty unless a test overrides it.
   mockDomain.findAll.mockResolvedValue([]);
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
   mockAccount.findOne.mockResolvedValue(null);
   mockApiKey.findAll.mockResolvedValue([]);
   mockInvite.findAll.mockResolvedValue([]);
   mockFeatureRequest.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/export tenant scoping', () => {
   it('returns ONLY the caller tenant\'s data and scopes every query to its own owner_id / domains', async () => {
      asCaller(TENANT_A);
      // The tenant owns exactly a.com; b.com belongs to another tenant and must never appear.
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, search_console: null })]);
      mockKeyword.findAll.mockResolvedValue([row({ ID: 11, keyword: 'seo', domain: 'a.com', owner_id: TENANT_A.ID })]);
      mockEvent.findAll.mockResolvedValue([row({ ID: 31, domain: 'a.com', name: 'pageview' })]);

      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(200);

      // Domains: scoped to the tenant owner_id.
      expect(mockDomain.findAll.mock.calls[0][0].where).toEqual({ owner_id: TENANT_A.ID });

      // Keywords + events: BOTH owner_id AND a domain-IN filter limited to the caller's own domains.
      const kwWhere = mockKeyword.findAll.mock.calls[0][0].where;
      expect(kwWhere.owner_id).toBe(TENANT_A.ID);
      expect(kwWhere.domain[Op.in]).toEqual(['a.com']);
      const evWhere = mockEvent.findAll.mock.calls[0][0].where;
      expect(evWhere.owner_id).toBe(TENANT_A.ID);
      expect(evWhere.domain[Op.in]).toEqual(['a.com']);

      // Account + api-key metadata are read for THIS account id only.
      expect(mockAccount.findOne.mock.calls[0][0].where).toEqual({ ID: TENANT_A.ID });
      expect(mockApiKey.findAll.mock.calls[0][0].where).toEqual({ account_id: TENANT_A.ID });

      // The bundle reflects only the caller's rows.
      const payload = res.payload as Record<string, any>;
      expect(payload.accountId).toBe(TENANT_A.ID);
      expect(payload.domains.map((d: any) => d.domain)).toEqual(['a.com']);
      expect(payload.counts).toMatchObject({ domains: 1, keywords: 1, events: 1 });
   });

   it('scopes keyword and event reads to an EMPTY domain set when the tenant owns no domains', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([]); // tenant owns nothing
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      // With no owned domains, the domain-IN filter is an empty list, so no foreign rows can leak.
      expect(mockKeyword.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
      expect(mockEvent.findAll.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
   });

   it('does NOT scope the admin / single-tenant export (no owner_id key)', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'legacy.com', search_console: null })]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      const where = mockDomain.findAll.mock.calls[0][0].where;
      expect(where).toEqual({});
      expect(Object.prototype.hasOwnProperty.call(where, 'owner_id')).toBe(false);
      // Keyword/event reads carry no owner_id scoping for the admin caller either.
      expect(Object.prototype.hasOwnProperty.call(mockKeyword.findAll.mock.calls[0][0].where, 'owner_id')).toBe(false);
      expect((res.payload as Record<string, unknown>).accountId).toBe(ADMIN_ACCOUNT_ID);
   });
});

describe('GET /api/export never emits a secret', () => {
   it('strips the encrypted search_console blob to a boolean and never includes its value', async () => {
      asCaller(TENANT_A);
      const encryptedBlob = JSON.stringify({ client_email: 'svc@x.com', private_key: 'PRIVATE_KEY_VALUE' });
      mockDomain.findAll.mockResolvedValue([
         row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, search_console: encryptedBlob }),
      ]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      const domain = (res.payload as Record<string, any>).domains[0];
      expect(domain.search_console).toBeUndefined();
      expect(domain.search_console_configured).toBe(true);
      // The encrypted/secret value must not appear anywhere in the serialized response.
      expect(JSON.stringify(res.payload)).not.toContain('PRIVATE_KEY_VALUE');
   });

   it('reports search_console_configured=false when no credentials are present', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, search_console: null })]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect((res.payload as Record<string, any>).domains[0].search_console_configured).toBe(false);
   });

   it('emits api keys as metadata only and NEVER includes the key_hash', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([]);
      mockAccount.findOne.mockResolvedValue(row({ ID: TENANT_A.ID, name: 'Tenant A', plan: 'free' }));
      mockApiKey.findAll.mockResolvedValue([
         row({
            ID: 9,
            name: 'cli',
            key_prefix: 's33k_abc123',
            key_hash: 'SUPER_SECRET_HASH_VALUE',
            role: 'admin',
            last_used_at: null,
            revoked_at: null,
         }),
      ]);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      const apiKeys = (res.payload as Record<string, any>).apiKeys;
      expect(apiKeys).toHaveLength(1);
      expect(apiKeys[0]).toMatchObject({ id: 9, name: 'cli', key_prefix: 's33k_abc123', role: 'admin' });
      expect(apiKeys[0].key_hash).toBeUndefined();
      // The hash must not appear anywhere in the serialized response.
      expect(JSON.stringify(res.payload)).not.toContain('SUPER_SECRET_HASH_VALUE');
   });
});

describe('GET /api/export method + auth gating', () => {
   it('401s an unauthorized caller and never reads any data', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: undefined, error: 'nope' });
      const res = makeRes();
      await exportHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(401);
      expect(mockDomain.findAll).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await exportHandler(makeReq({ method: 'POST' }), res);

      expect(res.statusCode).toBe(405);
      expect(mockDomain.findAll).not.toHaveBeenCalled();
   });
});
