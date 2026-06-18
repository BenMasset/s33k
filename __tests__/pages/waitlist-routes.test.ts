import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for the waitlist route (pages/api/waitlist.ts).
 *
 * Contracts under test:
 *   POST /api/waitlist (PUBLIC, no API key):
 *     1. A fresh email creates a 'waiting' waitlist row and returns a thank-you.
 *     2. Dedupe by email: a repeat signup does NOT create a second row and returns the SAME
 *        thank-you shape, so the endpoint never reveals whether an email already exists.
 *     3. A concurrent unique-constraint collision is swallowed to the same thank-you (no 4xx).
 *     4. A missing / malformed email is rejected with a 400.
 *   GET /api/waitlist (ADMIN only):
 *     5. The seeded admin (ID === ADMIN_ACCOUNT_ID) can list; a non-admin tenant is 403'd and
 *        never lists.
 *
 * No network, no DB: database/database is a no-op, the Waitlist + Account models are jest
 * mocks, and authorize is mocked per-test to inject the caller for the admin GET.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOrCreate: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../database/models/waitlist', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import waitlistHandler from '../../pages/api/waitlist';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import WaitlistModel from '../../database/models/waitlist';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockAccount = AccountModel as unknown as { findOrCreate: jest.Mock, findOne: jest.Mock };
const mockWaitlist = WaitlistModel as unknown as { create: jest.Mock, findOne: jest.Mock, findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const asCaller = (account: unknown) => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role: 'admin' });
};

const makeReq = (opts: { method?: string, body?: unknown, ip?: string } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: {},
   // A per-test IP keeps each test on its OWN rate-limit bucket so they never interfere.
   headers: opts.ip ? { 'x-forwarded-for': opts.ip } : {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.setHeader = jest.fn(() => res);
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   mockAccount.findOrCreate.mockResolvedValue([{ ID: ADMIN_ACCOUNT_ID }, false]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/waitlist: create', () => {
   it('creates a fresh waiting row for a new email and returns a thank-you', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      mockWaitlist.create.mockResolvedValue({ ID: 1, email: 'new@person.com', status: 'waiting' });
      const req = makeReq({ method: 'POST', body: { email: 'new@person.com', domain: 'person.com' } });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.success).toBe(true);
      expect(mockWaitlist.create).toHaveBeenCalledTimes(1);
      const createArg = mockWaitlist.create.mock.calls[0][0];
      // Email is normalized to lower-case; status defaults to waiting.
      expect(createArg.email).toBe('new@person.com');
      expect(createArg.domain).toBe('person.com');
      expect(createArg.status).toBe('waiting');
   });

   it('normalizes a mixed-case email to lower-case before storing', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      mockWaitlist.create.mockResolvedValue({ ID: 2 });
      const req = makeReq({ method: 'POST', body: { email: 'MixedCase@Person.COM' } });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(mockWaitlist.create.mock.calls[0][0].email).toBe('mixedcase@person.com');
   });
});

describe('POST /api/waitlist: dedupe', () => {
   it('does NOT create a second row for a duplicate email and returns the same thank-you', async () => {
      mockWaitlist.findOne.mockResolvedValue({ ID: 1, email: 'dupe@person.com', status: 'waiting' });
      const req = makeReq({ method: 'POST', body: { email: 'dupe@person.com' } });
      const res = makeRes();

      await waitlistHandler(req, res);

      // Same success shape (no existence leak), but no second insert.
      expect(res.statusCode).toBe(200);
      expect(res.payload.success).toBe(true);
      expect(mockWaitlist.create).not.toHaveBeenCalled();
   });

   it('swallows a concurrent unique-constraint collision to the same thank-you', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      mockWaitlist.create.mockRejectedValue({ name: 'SequelizeUniqueConstraintError' });
      const req = makeReq({ method: 'POST', body: { email: 'race@person.com' } });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.success).toBe(true);
   });
});

describe('POST /api/waitlist: validation', () => {
   it('400s a missing email and never creates a row', async () => {
      const req = makeReq({ method: 'POST', body: {} });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockWaitlist.create).not.toHaveBeenCalled();
   });

   it('400s a malformed email and never creates a row', async () => {
      const req = makeReq({ method: 'POST', body: { email: 'not-an-email' } });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockWaitlist.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/waitlist: length caps (audit area 1)', () => {
   it('hard-caps domain (<=255) and note (<=500) before persisting', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      mockWaitlist.create.mockResolvedValue({ ID: 9 });
      // A valid email, an over-long domain, and a megabyte-ish note. The caps must clamp the two
      // free-text fields before the row is written, so neither can bloat the (TEXT) columns.
      const req = makeReq({
         method: 'POST',
         ip: '203.0.113.10',
         body: { email: 'ok@person.com', domain: 'd'.repeat(1000), note: 'n'.repeat(5000) },
      });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(201);
      const arg = mockWaitlist.create.mock.calls[0][0];
      expect(arg.domain.length).toBe(255);
      expect(arg.note.length).toBe(500);
   });

   it('rejects an email longer than the 254 cap (cap applies before validation)', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      // The email cap truncates mid-string, which strips the domain part, so an over-long email is
      // no longer a valid shape and is correctly 400'd. This proves the cap runs before persisting.
      const req = makeReq({ method: 'POST', ip: '203.0.113.11', body: { email: `${'a'.repeat(300)}@person.com` } });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(mockWaitlist.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/waitlist: per-IP rate limit (audit area 1)', () => {
   it('429s once the per-IP brake (default 20/window) is exceeded and stops creating rows', async () => {
      mockWaitlist.findOne.mockResolvedValue(null);
      mockWaitlist.create.mockResolvedValue({ ID: 1 });
      const ip = '203.0.113.20';

      // The default WAITLIST_RATE_LIMIT is 20 per window. The first 20 from one IP are accepted.
      for (let i = 0; i < 20; i += 1) {
         const ok = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await waitlistHandler(makeReq({ ip, body: { email: `ok${i}@person.com` } }), ok);
         expect(ok.statusCode).toBe(201);
      }
      // The 21st from the same IP is rejected before any DB write.
      const blocked = makeRes();
      await waitlistHandler(makeReq({ ip, body: { email: 'over@person.com' } }), blocked);
      expect(blocked.statusCode).toBe(429);
      expect(mockWaitlist.create).toHaveBeenCalledTimes(20);
   });
});

describe('GET /api/waitlist: admin-only list', () => {
   it('lets the seeded admin list the waitlist', async () => {
      asCaller({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' });
      mockWaitlist.findAll.mockResolvedValue([{ ID: 1, email: 'a@b.com', status: 'waiting', get: () => null }]);
      const req = makeReq({ method: 'GET' });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.payload.waitlist)).toBe(true);
      expect(mockWaitlist.findAll).toHaveBeenCalledTimes(1);
   });

   it('403s a NON-admin tenant and never lists the waitlist', async () => {
      asCaller({ ID: 2, name: 'Tenant A', status: 'active' });
      const req = makeReq({ method: 'GET' });
      const res = makeRes();

      await waitlistHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockWaitlist.findAll).not.toHaveBeenCalled();
   });
});
