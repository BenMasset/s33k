import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for the PUBLIC self-serve signup route (pages/api/signup.ts).
 *
 * Contracts under test:
 *   POST /api/signup (PUBLIC, no API key, email is the input):
 *     1. MULTI_TENANT off  -> 404, no DB touch (single-tenant has no public signup).
 *     2. A NEW email -> createTrialingAccount + sendLoginLink invoked, returns { sent: true }, and
 *        NO API key is ever returned (email-verified by construction: the key is minted later at
 *        verify-link when the user clicks the emailed link).
 *     3. An EXISTING email (an account already holds it) -> NO second account, NO login link, and
 *        the SAME { sent: true } response (non-leak: the caller cannot tell new from existing).
 *     4. A malformed email -> SAME { sent: true }, never looks anything up (non-leak).
 *     5. Per-IP and per-email rate limits -> 429 once the cap is exceeded.
 *     6. CORS preflight (OPTIONS) from an allowlisted origin -> 204 + the allow-origin header.
 *
 * No network, no DB: database/database is a no-op, the Account model is a jest mock, and
 * createTrialingAccount + sendLoginLink are mocked so no real account is created and no email sent.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../utils/ensureAdminAccount', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));

jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn() },
}));
// The account-mint core + the login-link issuer are mocked so the route's wiring is asserted
// directly, without touching the real Account.create / Invite.create / Resend paths.
jest.mock('../../utils/provisionAccount', () => ({
   __esModule: true,
   createTrialingAccount: jest.fn(async () => ({ ID: 42, status: 'active' })),
   default: jest.fn(async () => ({ ID: 42, status: 'active' })),
}));
jest.mock('../../utils/sendLoginLink', () => ({
   __esModule: true,
   sendLoginLink: jest.fn(async () => undefined),
   LOGIN_TOKEN_TTL_MS: 15 * 60 * 1000,
   default: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import signupHandler from '../../pages/api/signup';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import { createTrialingAccount } from '../../utils/provisionAccount';
// eslint-disable-next-line import/first
import { sendLoginLink } from '../../utils/sendLoginLink';
// eslint-disable-next-line import/first
import { emailHash } from '../../utils/accountEmail';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockAccount = AccountModel as unknown as { create: jest.Mock, findOne: jest.Mock };
const mockCreateTrialing = createTrialingAccount as unknown as jest.Mock;
const mockSendLoginLink = sendLoginLink as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

// Each test uses a UNIQUE IP so the in-module per-IP rate limiters never bleed across tests.
let ipCounter = 0;
const nextIp = (): string => { ipCounter += 1; return `10.5.0.${ipCounter}`; };

const makeReq = (opts: { method?: string, body?: unknown, ip?: string, origin?: string } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: {},
   headers: {
      'x-forwarded-for': opts.ip || nextIp(),
      ...(opts.origin ? { origin: opts.origin } : {}),
   },
   socket: { remoteAddress: opts.ip || '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.headers = {} as Record<string, unknown>;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.setHeader = jest.fn((k: string, v: unknown) => { (res.headers as Record<string, unknown>)[k] = v; return res; });
   res.end = jest.fn(() => res);
   return res as unknown as NextApiResponse
      & { statusCode: number, payload: Record<string, unknown>, headers: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // SECRET keys the email blind index (emailHash), used by the route to look the email up.
   process.env.SECRET = 'test-secret-for-signup-hash';
   delete process.env.RESEND_API_KEY;
   mockCreateTrialing.mockResolvedValue({ ID: 42, status: 'active' });
   mockSendLoginLink.mockResolvedValue(undefined);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/signup: flag gate', () => {
   it('404s when MULTI_TENANT is off and never touches the DB', async () => {
      process.env.MULTI_TENANT = 'false';
      const res = makeRes();
      await signupHandler(makeReq({ body: { email: 'new@co.com' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
      expect(mockCreateTrialing).not.toHaveBeenCalled();
      expect(mockSendLoginLink).not.toHaveBeenCalled();
   });
});

describe('POST /api/signup: new email', () => {
   it('mints a trialing account + sends a login link and returns { sent: true } with NO key', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      const res = makeRes();
      await signupHandler(makeReq({ body: { email: 'New@Co.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      // No API key is ever returned: signup is email-verified by construction.
      expect(res.payload.apiKey).toBeUndefined();
      // Lookup is by the deterministic email_hash blind index, computed from the normalized email.
      expect(mockAccount.findOne.mock.calls[0][0].where.email_hash).toBe(emailHash('new@co.com'));
      expect(mockAccount.findOne.mock.calls[0][0].where.email).toBeUndefined();
      // The shared mint core + the login-link issuer were invoked with the normalized email.
      expect(mockCreateTrialing).toHaveBeenCalledTimes(1);
      expect(mockCreateTrialing).toHaveBeenCalledWith('new@co.com');
      expect(mockSendLoginLink).toHaveBeenCalledTimes(1);
      // sendLoginLink(req, account, email): the minted account + normalized email are passed through.
      expect(mockSendLoginLink.mock.calls[0][1]).toEqual({ ID: 42, status: 'active' });
      expect(mockSendLoginLink.mock.calls[0][2]).toBe('new@co.com');
   });
});

describe('POST /api/signup: existing email (non-enumeration)', () => {
   it('does NOT create a second account or send a link for an existing email, SAME { sent: true }', async () => {
      mockAccount.findOne.mockResolvedValue({ ID: 7, status: 'active' });
      const res = makeRes();
      await signupHandler(makeReq({ body: { email: 'taken@co.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      // Non-leak: identical response shape to the new-email path, but nothing observable happens.
      expect(mockCreateTrialing).not.toHaveBeenCalled();
      expect(mockSendLoginLink).not.toHaveBeenCalled();
   });

   it('returns the IDENTICAL response shape for a new vs an existing email (non-enumeration proof)', async () => {
      // New email path.
      mockAccount.findOne.mockResolvedValueOnce(null);
      const resNew = makeRes();
      await signupHandler(makeReq({ body: { email: 'fresh@co.com' } }), resNew);

      // Existing email path.
      mockAccount.findOne.mockResolvedValueOnce({ ID: 9, status: 'active' });
      const resExisting = makeRes();
      await signupHandler(makeReq({ body: { email: 'known@co.com' } }), resExisting);

      // Same status and same body: the caller cannot tell the two apart.
      expect(resNew.statusCode).toBe(resExisting.statusCode);
      expect(resNew.payload).toEqual(resExisting.payload);
   });
});

describe('POST /api/signup: validation', () => {
   it('returns { sent: true } for a malformed email and never looks anything up', async () => {
      const res = makeRes();
      await signupHandler(makeReq({ body: { email: 'not-an-email' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
      expect(mockCreateTrialing).not.toHaveBeenCalled();
   });

   it('returns { sent: true } for a missing email and never looks anything up', async () => {
      const res = makeRes();
      await signupHandler(makeReq({ body: {} }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });
});

describe('POST /api/signup: rate limits', () => {
   it('429s on the per-IP rate limit once exhausted', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      const ip = '10.8.8.8';
      let last = makeRes();
      // Default per-IP cap is 10; the 11th from the same IP is limited.
      for (let i = 0; i < 11; i += 1) {
         last = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await signupHandler(makeReq({ ip, body: { email: `u${i}@co.com` } }), last);
      }
      expect(last.statusCode).toBe(429);
   });

   it('429s on the per-EMAIL rate limit even across different IPs', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      let last = makeRes();
      // Default per-email cap is 3; the 4th for the same email (each from a fresh IP) is limited.
      for (let i = 0; i < 4; i += 1) {
         last = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await signupHandler(makeReq({ ip: nextIp(), body: { email: 'victim@co.com' } }), last);
      }
      expect(last.statusCode).toBe(429);
   });
});

describe('POST /api/signup: CORS', () => {
   it('answers the cross-origin preflight (OPTIONS) from the landing with 204 + the allowed origin', async () => {
      const res = makeRes();
      await signupHandler(makeReq({ method: 'OPTIONS', origin: 'https://s33k.io' }), res);
      expect(res.statusCode).toBe(204);
      expect(res.end).toHaveBeenCalled();
      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://s33k.io');
      expect(String(res.headers['Access-Control-Allow-Methods'])).toContain('POST');
   });

   it('does NOT echo an allow-origin header for a non-allowlisted origin', async () => {
      const res = makeRes();
      await signupHandler(makeReq({ method: 'OPTIONS', origin: 'https://evil.example.com' }), res);
      expect(res.statusCode).toBe(204);
      expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
   });
});
