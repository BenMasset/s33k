import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for pages/api/feature-request.ts, the storage + admin side of the
 * request_feature MCP flow.
 *
 * Contracts under test:
 *   POST /api/feature-request (authed):
 *     1. SAFETY NET: a request that strongly matches an EXISTING capability is REFUSED. The
 *        route returns { stored: false, matched: true, capability } and stores NOTHING, even
 *        though the LLM was supposed to confirm first. This is the hard requirement: never
 *        record a request for something s33k already does.
 *     2. A genuinely NEW request is stored (status 'open', owner stamped) and the team is
 *        notified best-effort (notify is graceful and never fails the request).
 *     3. An empty request is rejected fast, before any DB write.
 *     4. A read-only MEMBER key is 401'd on the POST (authorize() blocks members on non-GET).
 *
 *   GET /api/feature-request (ADMIN only):
 *     5. The seeded admin lists requests, optionally filtered by status.
 *     6. A non-admin account is 403'd and never reads the table.
 *
 * The cross-check is the REAL utils/knowledge implementation (the single source), so the
 * safety net is tested end to end. No network, no DB: database is a no-op, the model is a jest
 * mock, authorize is mocked per-test, and notify is stubbed to a no-send result.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOrCreate: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../database/models/featureRequest', () => ({
   __esModule: true,
   default: { create: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/ensureAdminAccount', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
// notify must never touch the network; stub it to a no-send result.
jest.mock('../../utils/notify-feature-request', () => ({
   __esModule: true,
   notifyFeatureRequest: jest.fn(async () => ({ sent: false })),
   default: jest.fn(async () => ({ sent: false })),
}));

// eslint-disable-next-line import/first
import handler from '../../pages/api/feature-request';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import FeatureRequestModel from '../../database/models/featureRequest';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { notifyFeatureRequest } from '../../utils/notify-feature-request';

const mockFeatureRequest = FeatureRequestModel as unknown as { create: jest.Mock, findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockNotify = notifyFeatureRequest as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', status: 'active' };

const asCaller = (account: unknown) => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role: 'admin' });
};

const makeReq = (opts: { method?: string, body?: unknown, query?: Record<string, string> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body || {},
   query: opts.query || {},
   headers: {},
   socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.getHeader = jest.fn(() => undefined);
   res.setHeader = jest.fn(() => undefined);
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   mockNotify.mockResolvedValue({ sent: false });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/feature-request: safety net refuses requests for existing capabilities', () => {
   it('REFUSES a request that matches an existing capability and stores NOTHING', async () => {
      asCaller(TENANT_A);
      // "how far visitors scroll" maps strongly onto the existing scroll_depth capability.
      const req = makeReq({ method: 'POST', body: { request: 'Show me how far visitors scroll on each page' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.stored).toBe(false);
      expect(res.payload.matched).toBe(true);
      expect((res.payload.capability as { toolName: string }).toolName).toBe('scroll_depth');
      expect(res.payload.message).toMatch(/already/i);
      // The hard requirement: nothing is recorded for an existing capability.
      expect(mockFeatureRequest.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/feature-request: a genuinely new request is stored', () => {
   it('stores a new request with status open, stamps the owner, and notifies best-effort', async () => {
      asCaller(TENANT_A);
      mockFeatureRequest.create.mockResolvedValue({ ID: 7 });
      const req = makeReq({
         // A genuinely novel ask (no tool provides a UI theme toggle). Core Web Vitals is no longer
         // novel now that the web_vitals tool exists, so the safety net rightly matches it.
         method: 'POST',
         body: { request: 'Add dark mode and light mode theme switching to the UI', context: 'I forget to check' },
      });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.stored).toBe(true);
      expect(res.payload.matched).toBe(false);
      expect(res.payload.request_id).toBe(7);
      expect(mockFeatureRequest.create).toHaveBeenCalledTimes(1);
      const createArg = mockFeatureRequest.create.mock.calls[0][0];
      expect(createArg.account_id).toBe(TENANT_A.ID);
      expect(createArg.status).toBe('open');
      expect(createArg.matched_capability).toBeNull();
      expect(createArg.context).toBe('I forget to check');
      // Notification is best-effort and was attempted.
      expect(mockNotify).toHaveBeenCalledTimes(1);
   });

   it('still succeeds (request stored) when the notification send fails', async () => {
      asCaller(TENANT_A);
      mockFeatureRequest.create.mockResolvedValue({ ID: 8 });
      mockNotify.mockResolvedValue({ sent: false, error: 'boom' });
      const req = makeReq({ method: 'POST', body: { request: 'Add dark mode and light mode theme switching to the UI' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.stored).toBe(true);
      expect(res.payload.emailSent).toBe(false);
   });

   it('rejects an empty request fast, before any DB write', async () => {
      asCaller(TENANT_A);
      const req = makeReq({ method: 'POST', body: { request: '   ' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockFeatureRequest.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/feature-request: member keys are blocked by authorize()', () => {
   it('401s when authorize() rejects a read-only member on the write', async () => {
      // authorize() blocks members on non-GET, so it returns unauthorized for the POST.
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Read-only member' });
      const req = makeReq({ method: 'POST', body: { request: 'anything new' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(mockFeatureRequest.create).not.toHaveBeenCalled();
   });
});

describe('GET /api/feature-request: admin-only listing', () => {
   it('lists requests for the seeded admin, filtered by status', async () => {
      asCaller(ADMIN);
      mockFeatureRequest.findAll.mockResolvedValue([
         { ID: 3, account_id: 2, request: 'x', context: null, status: 'open', matched_capability: null, get: () => undefined },
      ]);
      const req = makeReq({ method: 'GET', query: { status: 'open' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.payload.requests)).toBe(true);
      const { where } = mockFeatureRequest.findAll.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(where.status).toBe('open');
   });

   it('ignores an unknown status filter (lists everything) rather than erroring', async () => {
      asCaller(ADMIN);
      mockFeatureRequest.findAll.mockResolvedValue([]);
      const req = makeReq({ method: 'GET', query: { status: 'bogus' } });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const { where } = mockFeatureRequest.findAll.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(where.status).toBeUndefined();
   });

   it('403s a non-admin account and never reads the table', async () => {
      asCaller(TENANT_A);
      const req = makeReq({ method: 'GET' });
      const res = makeRes();

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockFeatureRequest.findAll).not.toHaveBeenCalled();
   });
});
