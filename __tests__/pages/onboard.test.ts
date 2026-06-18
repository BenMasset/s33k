/**
 * Route-level tests for the guided onboarding orchestrator (pages/api/onboard.ts).
 *
 * The onboard endpoint is the one-call, one-input (domain) setup path. These tests assert the
 * orchestration contract end-to-end with every side-effecting dependency mocked:
 *   1. It creates the domain owner-stamped via the multi-tenant pattern (ownerIdFor), or reuses
 *      an existing owned row instead of creating a duplicate.
 *   2. It feeds heuristic discovery output into Keyword.bulkCreate, capped at the onboard max,
 *      globally deduped, each keyword owner-stamped and mapped to its page's target_page, and
 *      kicks off the background SERP refresh (not awaited).
 *   3. It provisions a per-domain Umami website and stamps Domain.umami_website_id, and returns
 *      the install snippet + guides.
 *   4. It degrades gracefully when Umami provisioning fails: umamiWebsiteId comes back null with
 *      a note, but the domain, keywords, rankings, and install guides still return (201, no 500).
 *
 * The DB layer is a no-op sync; the Domain/Keyword models, authorize, refresh, parseKeywords,
 * settings, keyword-discovery, and umami-provision are mocked. install-guides runs for real
 * (pure product knowledge) so the returned snippet shape is genuinely exercised. No network.
 *
 * The scope helpers (ownerIdFor / scopeWhere) are NOT mocked: the real flag-gated logic is
 * threaded through the real route so owner stamping is proven, not re-asserted.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findOne: jest.fn(), create: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: { bulkCreate: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('../../utils/parseKeywords', () => ({ __esModule: true, default: jest.fn((rows: unknown[]) => rows) }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({})) }));
jest.mock('../../utils/keyword-discovery', () => ({ __esModule: true, discoverKeywords: jest.fn() }));
jest.mock('../../utils/umami-provision', () => ({ __esModule: true, createUmamiWebsite: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import onboardHandler from '../../pages/api/onboard';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import refreshFn from '../../utils/refresh';
// eslint-disable-next-line import/first
import { discoverKeywords } from '../../utils/keyword-discovery';
// eslint-disable-next-line import/first
import { createUmamiWebsite } from '../../utils/umami-provision';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock, create: jest.Mock };
const mockKeyword = KeywordModel as unknown as { bulkCreate: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockRefresh = refreshFn as unknown as jest.Mock;
const mockDiscover = discoverKeywords as unknown as jest.Mock;
const mockProvision = createUmamiWebsite as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

/** A Domain row stand-in: update() records the patch and mutates the row. */
const domainRow = (data: Record<string, unknown>) => {
   const r: Record<string, unknown> = { ...data };
   r.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(r, patch); return r; });
   return r;
};

/** A Keyword row stand-in: get({plain}) returns the flat data. */
const keywordRow = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, any> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.UMAMI_BASE_URL = 'https://analytics.example.com';
   asCaller(ADMIN);
   mockDiscover.mockResolvedValue({ domain: 'getmasset.com', candidates: [] });
   mockProvision.mockResolvedValue({ websiteId: 'web-new', error: null });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/onboard happy path', () => {
   it('creates the domain, adds discovered keywords, provisions analytics, and returns the snippet + guides', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const row = domainRow({ ID: 10, domain: 'getmasset.com' });
      mockDomain.create.mockResolvedValue(row);
      mockDiscover.mockResolvedValue({
         domain: 'getmasset.com',
         candidates: [
            { page: 'https://getmasset.com/', suggestedKeywords: ['ai-ready dam', 'content home'] },
            { page: 'https://getmasset.com/software/mcp', suggestedKeywords: ['mcp server', 'ai-ready dam'] },
         ],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'https://www.GetMasset.com/path' } }), res);

      expect(res.statusCode).toBe(201);
      const payload = res.payload;
      // Domain normalized to a bare host before creation.
      expect(payload.domain).toBe('getmasset.com');
      expect(mockDomain.create).toHaveBeenCalledTimes(1);

      // Keywords are globally deduped: the second "ai-ready dam" is dropped.
      expect(payload.discoveredKeywords).toEqual(['ai-ready dam', 'content home', 'mcp server']);
      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.map((k) => k.keyword)).toEqual(['ai-ready dam', 'content home', 'mcp server']);
      // Each keyword carries its page's pathname as target_page.
      expect(created.find((k) => k.keyword === 'mcp server').target_page).toBe('/software/mcp');
      expect(created.find((k) => k.keyword === 'ai-ready dam').target_page).toBe('/');

      // Background SERP refresh is kicked off (not awaited) and rankings are pending.
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(payload.rankingsPending).toBe(true);

      // Analytics provisioned and stamped onto the Domain row.
      expect(payload.umamiWebsiteId).toBe('web-new');
      expect((row.update as jest.Mock)).toHaveBeenCalledWith({ umami_website_id: 'web-new' });

      // Install snippet + guides come back, embedding the new website id.
      expect(payload.installSnippet).toContain('data-website-id="web-new"');
      expect(payload.installGuides.platforms.length).toBeGreaterThan(0);
      expect(payload.note).toBeNull();
   });

   it('reuses an already-owned domain row instead of creating a duplicate', async () => {
      const row = domainRow({ ID: 11, domain: 'example.com', umami_website_id: 'existing-web' });
      mockDomain.findOne.mockResolvedValue(row);
      mockDiscover.mockResolvedValue({ domain: 'example.com', candidates: [] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'example.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(mockDomain.create).not.toHaveBeenCalled();
      // The already-stamped id is reused; no re-provision call.
      expect(res.payload.umamiWebsiteId).toBe('existing-web');
      expect(mockProvision).not.toHaveBeenCalled();
   });

   it('caps the number of added keywords at the onboard max', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 12, domain: 'big.com' }));
      // One page with 40 unique candidate keywords.
      const many = Array.from({ length: 40 }, (_v, i) => `keyword phrase ${i}`);
      mockDiscover.mockResolvedValue({
         domain: 'big.com',
         candidates: [{ page: 'https://big.com/', suggestedKeywords: many }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'big.com' } }), res);

      const created = mockKeyword.bulkCreate.mock.calls[0][0] as any[];
      expect(created.length).toBe(20);
      expect(res.payload.discoveredKeywords.length).toBe(20);
   });
});

describe('POST /api/onboard owner stamping', () => {
   it('stamps the tenant owner_id on the created domain and keywords', async () => {
      process.env.MULTI_TENANT = 'true';
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 20, domain: 'tenant.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'tenant.com',
         candidates: [{ page: 'https://tenant.com/', suggestedKeywords: ['tenant keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      await onboardHandler(makeReq({ body: { domain: 'tenant.com' } }), makeRes());

      expect(mockDomain.create.mock.calls[0][0].owner_id).toBe(TENANT.ID);
      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].owner_id).toBe(TENANT.ID);
   });

   it('stamps null owner_id for the admin (legacy NULL-owner storage)', async () => {
      process.env.MULTI_TENANT = 'true';
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 21, domain: 'admin.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'admin.com',
         candidates: [{ page: 'https://admin.com/', suggestedKeywords: ['admin keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));

      await onboardHandler(makeReq({ body: { domain: 'admin.com' } }), makeRes());

      expect(mockDomain.create.mock.calls[0][0].owner_id).toBeNull();
      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].owner_id).toBeNull();
   });
});

describe('POST /api/onboard canonicalization + cross-owner collision (cross-tenant-leak fix)', () => {
   // The domain is canonicalized once up front and used for find + create, so a "www."/uppercase/
   // trailing-dot variant resolves and stores the ONE canonical form. And before creating, a
   // canonical name already registered by ANY account is rejected, so a canonical-colliding sibling
   // can never become a second row under a different owner (the cross-tenant-leak precondition).
   it('rejects a domain whose canonical form is already registered (by another owner) without creating', async () => {
      process.env.MULTI_TENANT = 'true';
      asCaller(TENANT);
      // First findOne is the owner-scoped lookup (caller does NOT own it) -> null.
      // Second findOne is the unscoped canonical existence check -> a row owned by someone else.
      mockDomain.findOne
         .mockResolvedValueOnce(null)
         .mockResolvedValueOnce(domainRow({ ID: 99, domain: 'getmasset.com', owner_id: 7 }));

      const res = makeRes();
      // A trailing-dot variant of an already-registered canonical domain.
      await onboardHandler(makeReq({ body: { domain: 'getmasset.com.' } }), res);

      expect(res.statusCode).toBe(400);
      expect((res.payload as { error?: string }).error).toMatch(/already registered/i);
      expect(mockDomain.create).not.toHaveBeenCalled();
   });

   it('canonicalizes the create + find: a raw variant stores the bare canonical domain', async () => {
      process.env.MULTI_TENANT = 'true';
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 40, domain: 'getmasset.com' }));
      mockDiscover.mockResolvedValue({ domain: 'getmasset.com', candidates: [] });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'WWW.GetMasset.com.' } }), res);

      expect(res.statusCode).toBe(201);
      // The owner-scoped find AND the create both use the canonical bare host.
      expect(mockDomain.findOne.mock.calls[0][0].where.domain).toBe('getmasset.com');
      expect(mockDomain.create.mock.calls[0][0].domain).toBe('getmasset.com');
      expect((res.payload as { domain?: string }).domain).toBe('getmasset.com');
   });
});

describe('POST /api/onboard graceful degradation', () => {
   it('returns 201 with umamiWebsiteId null and a note when Umami provisioning fails', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 30, domain: 'noanalytics.com' }));
      mockDiscover.mockResolvedValue({
         domain: 'noanalytics.com',
         candidates: [{ page: 'https://noanalytics.com/', suggestedKeywords: ['a keyword'] }],
      });
      mockKeyword.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((k) => keywordRow(k)));
      mockProvision.mockResolvedValue({ websiteId: null, error: 'Umami auth failed.' });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'noanalytics.com' } }), res);

      expect(res.statusCode).toBe(201);
      // The domain, keywords, and rankings still come back.
      expect(res.payload.domain).toBe('noanalytics.com');
      expect(res.payload.rankingsPending).toBe(true);
      // Analytics is null with an explanatory note; install guides still return (empty id).
      expect(res.payload.umamiWebsiteId).toBeNull();
      expect(res.payload.note).toMatch(/not provisioned/i);
      expect(res.payload.installGuides.platforms.length).toBeGreaterThan(0);
      expect(res.payload.installSnippet).toContain('data-website-id=""');
   });

   it('surfaces a discovery error as the note when no keyword candidates are found', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue(domainRow({ ID: 31, domain: 'unreachable.example' }));
      mockDiscover.mockResolvedValue({ domain: 'unreachable.example', candidates: [], error: 'Could not reach this site.' });

      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'unreachable.example' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.discoveredKeywords).toEqual([]);
      expect(res.payload.rankingsPending).toBe(false);
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
      expect(res.payload.note).toMatch(/could not reach/i);
   });
});

describe('POST /api/onboard guards', () => {
   it('rejects an unauthorized caller with 401', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'nope' });
      const res = makeRes();
      await onboardHandler(makeReq({ body: { domain: 'x.com' } }), res);
      expect(res.statusCode).toBe(401);
   });

   it('rejects a non-POST method with 405', async () => {
      const res = makeRes();
      await onboardHandler(makeReq({ method: 'GET', body: {} }), res);
      expect(res.statusCode).toBe(405);
   });

   it('rejects a missing domain with 400', async () => {
      const res = makeRes();
      await onboardHandler(makeReq({ body: {} }), res);
      expect(res.statusCode).toBe(400);
   });
});
