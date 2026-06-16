/**
 * Adversarial cross-tenant ownership tests for the four autocapture READ routes
 * (top-clicks, form-submissions, scroll-depth, page-engagement), which take a ?domain=
 * and read the s33k_event store.
 *
 * SECURITY-CRITICAL contract under test (with MULTI_TENANT = 'true'):
 *   1. Before any event read, the route verifies the requested domain is owned by the
 *      caller via Domain.findOne({ where: { domain, ...scopeWhere(account) } }).
 *   2. A tenant asking about a domain it does NOT own gets a 403 and the event store is
 *      NEVER queried (S33kEvent.findAll is not called).
 *   3. When the domain IS owned, the route proceeds AND the S33kEvent read itself carries
 *      the tenant owner_id scope (defense in depth: even a domain-name collision cannot
 *      leak another tenant's events).
 *   4. The admin caller is unscoped: neither the ownership lookup nor the event read has
 *      an owner_id key.
 *
 * The models are mocked, authorize is mocked per-test, and scopeWhere runs for real so the
 * scoped where-clause is the genuine flag-gated output. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));

// The routes import { Op } from 'sequelize'. Stub it so jest never transforms sequelize's
// ESM deps; the models are mocked, so Op is only a unique object key in the findAll where.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import topClicksHandler from '../../pages/api/top-clicks';
// eslint-disable-next-line import/first
import formSubmissionsHandler from '../../pages/api/form-submissions';
// eslint-disable-next-line import/first
import scrollDepthHandler from '../../pages/api/scroll-depth';
// eslint-disable-next-line import/first
import pageEngagementHandler from '../../pages/api/page-engagement';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (query: Record<string, string> = {}): NextApiRequest => ({
   method: 'GET',
   query,
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const ROUTES: Array<{ name: string, handler: Handler }> = [
   { name: 'top-clicks', handler: topClicksHandler as unknown as Handler },
   { name: 'form-submissions', handler: formSubmissionsHandler as unknown as Handler },
   { name: 'scroll-depth', handler: scrollDepthHandler as unknown as Handler },
   { name: 'page-engagement', handler: pageEngagementHandler as unknown as Handler },
];

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe.each(ROUTES)('GET /api/$name autocapture-read ownership guard', ({ handler }) => {
   it('403s a tenant requesting a domain it does NOT own and never reads s33k_event', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await handler(makeReq({ domain: 'someone-elses.com' }), res);

      expect(res.statusCode).toBe(403);
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'someone-elses.com', owner_id: TENANT.ID });
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('proceeds AND scopes the s33k_event read by owner_id when the tenant DOES own the domain', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: TENANT.ID });
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await handler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.findAll).toHaveBeenCalledTimes(1);
      // The event read itself carries owner_id, not just the ownership pre-check.
      expect(mockEvent.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'a.com', owner_id: TENANT.ID });
   });

   it('admin is unscoped: no owner_id key on the ownership lookup or the event read', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockEvent.findAll.mockResolvedValue([]);

      await handler(makeReq({ domain: 'a.com' }), makeRes());

      expect(Object.prototype.hasOwnProperty.call(mockDomain.findOne.mock.calls[0][0].where, 'owner_id')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(mockEvent.findAll.mock.calls[0][0].where, 'owner_id')).toBe(false);
   });

   it('400s when domain is missing', async () => {
      asCaller(TENANT);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await handler(makeReq({}), res);

      expect(res.statusCode).toBe(400);
      expect(mockDomain.findOne).not.toHaveBeenCalled();
   });

   it('405s a non-GET method', async () => {
      asCaller(TENANT);
      const res = makeRes() as NextApiResponse & { statusCode: number };
      const req = { method: 'POST', query: {}, headers: {} } as unknown as NextApiRequest;

      await handler(req, res);

      expect(res.statusCode).toBe(405);
   });
});
