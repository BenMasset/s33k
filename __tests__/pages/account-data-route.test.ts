/**
 * Adversarial tests for the HARD DELETE route (pages/api/account-data.ts).
 *
 * This route is SECURITY-CRITICAL and IRREVERSIBLE. Three guardrails under test
 * (with MULTI_TENANT = 'true'):
 *   1. CONFIRMATION-GATED. Without an exact { confirm: "DELETE" } body the route 400s
 *      and deletes NOTHING (no model destroy is ever called).
 *   2. ADMIN REFUSED. The admin/legacy account (ID === ADMIN_ACCOUNT_ID) is 403'd and
 *      deletes nothing. The MULTI_TENANT-off / null-account path resolves to the admin
 *      id, so the route is inert in single-tenant mode.
 *   3. TENANT-SCOPED. A real tenant's deletes only ever touch the caller's OWN rows:
 *      domains/keywords/events carry owner_id; keywords/events/crawler-hits are bounded
 *      by the caller's own domain-IN set; api keys + the account row are scoped to the
 *      caller's exact account id. A second tenant's data is untouched.
 *   + The best-effort Umami website deprovision NEVER throws and never aborts the delete:
 *     a failed deleteUmamiWebsite is collected as a warning and the account delete proceeds.
 *
 * The DB layer is mocked to a no-op sync, every model is mocked so each destroy is a pure
 * assertion on the where-clause the route built, sequelize Op is stubbed (the route imports
 * it directly), deleteUmamiWebsite is mocked (no network), and authorize injects the caller.
 * The real scopeWhere is threaded through. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/invite', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../database/models/featureRequest', () => ({ __esModule: true, default: { destroy: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/umami-provision', () => ({ __esModule: true, deleteUmamiWebsite: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import { Op } from 'sequelize';
// eslint-disable-next-line import/first
import deleteHandler from '../../pages/api/account-data';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import CrawlerHitModel from '../../database/models/crawlerHit';
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
// eslint-disable-next-line import/first
import { deleteUmamiWebsite } from '../../utils/umami-provision';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock, destroy: jest.Mock };
const mockKeyword = KeywordModel as unknown as { destroy: jest.Mock };
const mockCrawlerHit = CrawlerHitModel as unknown as { destroy: jest.Mock };
const mockEvent = S33kEventModel as unknown as { destroy: jest.Mock };
const mockAccount = AccountModel as unknown as { destroy: jest.Mock };
const mockApiKey = ApiKeyModel as unknown as { destroy: jest.Mock };
const mockInvite = InviteModel as unknown as { destroy: jest.Mock };
const mockFeatureRequest = FeatureRequestModel as unknown as { destroy: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockDeleteUmami = deleteUmamiWebsite as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'DELETE',
   body: opts.body || {},
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

const expectNothingDeleted = () => {
   expect(mockDomain.destroy).not.toHaveBeenCalled();
   expect(mockKeyword.destroy).not.toHaveBeenCalled();
   expect(mockCrawlerHit.destroy).not.toHaveBeenCalled();
   expect(mockEvent.destroy).not.toHaveBeenCalled();
   expect(mockApiKey.destroy).not.toHaveBeenCalled();
   expect(mockInvite.destroy).not.toHaveBeenCalled();
   expect(mockFeatureRequest.destroy).not.toHaveBeenCalled();
   expect(mockAccount.destroy).not.toHaveBeenCalled();
   expect(mockDeleteUmami).not.toHaveBeenCalled();
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   mockDomain.findAll.mockResolvedValue([]);
   mockDomain.destroy.mockResolvedValue(0);
   mockKeyword.destroy.mockResolvedValue(0);
   mockCrawlerHit.destroy.mockResolvedValue(0);
   mockEvent.destroy.mockResolvedValue(0);
   mockApiKey.destroy.mockResolvedValue(0);
   mockInvite.destroy.mockResolvedValue(0);
   mockFeatureRequest.destroy.mockResolvedValue(0);
   mockAccount.destroy.mockResolvedValue(0);
   mockDeleteUmami.mockResolvedValue({ deleted: true, error: null });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('DELETE /api/account-data confirmation gate', () => {
   it('400s and deletes NOTHING when the confirmation is missing', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: {} }), res);

      expect(res.statusCode).toBe(400);
      expectNothingDeleted();
   });

   it('400s and deletes NOTHING when the confirmation is wrong', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'delete' } }), res);

      expect(res.statusCode).toBe(400);
      expectNothingDeleted();
   });
});

describe('DELETE /api/account-data admin refusal', () => {
   it('403s the admin account and deletes NOTHING even with a valid confirmation', async () => {
      asCaller(ADMIN);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(403);
      expectNothingDeleted();
   });

   it('403s the null-account (MULTI_TENANT-off / legacy) path, which resolves to admin', async () => {
      process.env.MULTI_TENANT = 'false';
      asCaller(null);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(403);
      expectNothingDeleted();
   });
});

describe('DELETE /api/account-data tenant scoping', () => {
   it('deletes ONLY the caller tenant\'s rows, every destroy scoped to its own owner_id / domains', async () => {
      asCaller(TENANT_A);
      // The tenant owns a.com only. b.com is another tenant's domain and must never be targeted.
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, umami_website_id: null })]);
      mockKeyword.destroy.mockResolvedValue(3);
      mockEvent.destroy.mockResolvedValue(5);
      mockCrawlerHit.destroy.mockResolvedValue(7);
      mockDomain.destroy.mockResolvedValue(1);
      mockApiKey.destroy.mockResolvedValue(2);
      mockAccount.destroy.mockResolvedValue(1);

      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(200);

      // The owned-domain lookup that bounds every domain-keyed delete is itself owner-scoped.
      expect(mockDomain.findAll.mock.calls[0][0].where).toEqual({ owner_id: TENANT_A.ID });

      // Keywords + events: owner_id AND a domain-IN filter limited to the caller's own domains.
      const kwWhere = mockKeyword.destroy.mock.calls[0][0].where;
      expect(kwWhere.owner_id).toBe(TENANT_A.ID);
      expect(kwWhere.domain[Op.in]).toEqual(['a.com']);
      const evWhere = mockEvent.destroy.mock.calls[0][0].where;
      expect(evWhere.owner_id).toBe(TENANT_A.ID);
      expect(evWhere.domain[Op.in]).toEqual(['a.com']);

      // Crawler hits: no owner_id column, scoped purely by the caller's own domain set.
      expect(mockCrawlerHit.destroy.mock.calls[0][0].where.domain[Op.in]).toEqual(['a.com']);

      // Domains: owner-scoped. Api keys + account row: exact account id only, never a wildcard.
      expect(mockDomain.destroy.mock.calls[0][0].where).toEqual({ owner_id: TENANT_A.ID });
      expect(mockApiKey.destroy.mock.calls[0][0].where).toEqual({ account_id: TENANT_A.ID });
      expect(mockAccount.destroy.mock.calls[0][0].where).toEqual({ ID: TENANT_A.ID });

      const payload = res.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
         deleted: true,
         deletedAccountId: TENANT_A.ID,
         keywordsRemoved: 3,
         eventsRemoved: 5,
         domainsRemoved: 1,
         apiKeysRemoved: 2,
         accountRemoved: true,
      });
   });

   it('does NOT delete a second tenant\'s data: only the caller\'s owned domain set is ever targeted', async () => {
      asCaller(TENANT_A);
      // findAll is already owner-scoped, so it returns only the caller's domains. Even so,
      // assert the destroy filters can never reach a foreign domain like b.com.
      mockDomain.findAll.mockResolvedValue([row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, umami_website_id: null })]);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      const targetedDomains = mockKeyword.destroy.mock.calls[0][0].where.domain[Op.in];
      expect(targetedDomains).toEqual(['a.com']);
      expect(targetedDomains).not.toContain('b.com');
      // Account-row destroy is keyed to the caller's id, so tenant B's account row is safe.
      expect(mockAccount.destroy.mock.calls[0][0].where).toEqual({ ID: TENANT_A.ID });
   });

   it('uses an empty domain-IN set (no foreign rows) when the tenant owns no domains', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([]);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockKeyword.destroy.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
      expect(mockEvent.destroy.mock.calls[0][0].where.domain[Op.in]).toEqual([]);
      // Crawler hits aren't queried at all when there are no owned domains.
      expect(mockCrawlerHit.destroy).not.toHaveBeenCalled();
   });
});

describe('DELETE /api/account-data best-effort Umami deprovision', () => {
   it('deletes each per-domain Umami website and reports the count', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([
         row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, umami_website_id: 'umami-a' }),
         row({ ID: 2, domain: 'b.com', owner_id: TENANT_A.ID, umami_website_id: 'umami-b' }),
      ]);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(mockDeleteUmami).toHaveBeenCalledTimes(2);
      expect(mockDeleteUmami).toHaveBeenCalledWith('umami-a');
      expect(mockDeleteUmami).toHaveBeenCalledWith('umami-b');
      expect((res.payload as Record<string, unknown>).umamiWebsitesDeleted).toBe(2);
   });

   it('does NOT throw or abort the delete when the Umami website delete fails', async () => {
      asCaller(TENANT_A);
      mockDomain.findAll.mockResolvedValue([
         row({ ID: 1, domain: 'a.com', owner_id: TENANT_A.ID, umami_website_id: 'umami-a' }),
      ]);
      // Provider hiccup: returns a failure object (never throws, by contract).
      mockDeleteUmami.mockResolvedValue({ deleted: false, error: 'Umami auth failed.' });
      mockDomain.destroy.mockResolvedValue(1);
      mockAccount.destroy.mockResolvedValue(1);

      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      // The account delete still completes; the failure is surfaced as a warning, not an abort.
      expect(res.statusCode).toBe(200);
      const payload = res.payload as Record<string, any>;
      expect(payload.deleted).toBe(true);
      expect(payload.umamiWebsitesDeleted).toBe(0);
      expect(payload.warnings.some((w: string) => w.includes('umami-a'))).toBe(true);
      expect(mockDomain.destroy).toHaveBeenCalled();
      expect(mockAccount.destroy).toHaveBeenCalled();
   });
});

describe('DELETE /api/account-data method + auth gating', () => {
   it('401s an unauthorized caller and deletes nothing', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: undefined, error: 'nope' });
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'DELETE', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(401);
      expectNothingDeleted();
   });

   it('405s a non-DELETE method', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await deleteHandler(makeReq({ method: 'GET', body: { confirm: 'DELETE' } }), res);

      expect(res.statusCode).toBe(405);
      expectNothingDeleted();
   });
});
