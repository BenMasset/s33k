import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for the passwordless magic-link login routes
 * (pages/api/auth/request-link.ts and pages/api/auth/verify-link.ts), plus the
 * email-stamping + race-safety of pages/api/invite/accept.ts acceptExternal.
 *
 * Contracts under test:
 *
 *   POST /api/auth/request-link (PUBLIC, the email is the input):
 *     1. MULTI_TENANT off  -> 404, no DB touch.
 *     2. Existing active email -> creates a single-use 'login' Invite token (15-min TTL, type
 *        'login', target_account_id = the account), attempts the magic-link send, returns
 *        { sent: true }.
 *     3. UNKNOWN email -> SAME { sent: true } response and NO token created (non-leak).
 *     4. Per-IP and per-email rate limits -> 429 once exhausted.
 *
 *   POST /api/auth/verify-link (PUBLIC, the token is the credential):
 *     5. MULTI_TENANT off  -> 404, no DB touch.
 *     6. A valid 'login' token -> mints a FRESH ADMIN api_key ONCE on the token's account,
 *        returns the key + mcpConfig, claim-before-mint flips it pending -> used.
 *     7. A USED (non-pending) token -> generic reject, never mints.
 *     8. An EXPIRED (>15m) token -> generic reject, lazily flips to 'expired', never mints.
 *     9. A NON-LOGIN invite code (type 'external') -> generic reject (type guard), never mints.
 *    10. RACE: the atomic claim flips 0 rows -> generic reject, mints NOTHING.
 *
 *   POST /api/invite/accept acceptExternal:
 *    11. Still sets account.email from the invite and stays race-safe (claim-before-mint).
 *    12. Email-collision on create -> retries without email, still succeeds (no 500).
 *
 * No network, no DB: database/database is a no-op, the models are jest mocks, send helpers are
 * mocked so no email is sent.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../utils/ensureAdminAccount', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));

jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../database/models/invite', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn(), update: jest.fn() },
}));
// The email senders must never touch the network.
jest.mock('../../utils/send-invite', () => ({
   __esModule: true,
   sendInviteEmail: jest.fn(async () => ({ sent: false })),
   sendMagicLinkEmail: jest.fn(async () => ({ sent: false })),
   default: jest.fn(async () => ({ sent: false })),
}));

// eslint-disable-next-line import/first
import requestLinkHandler from '../../pages/api/auth/request-link';
// eslint-disable-next-line import/first
import verifyLinkHandler from '../../pages/api/auth/verify-link';
// eslint-disable-next-line import/first
import acceptHandler from '../../pages/api/invite/accept';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import InviteModel from '../../database/models/invite';
// eslint-disable-next-line import/first
import { sendMagicLinkEmail } from '../../utils/send-invite';

const mockAccount = AccountModel as unknown as { create: jest.Mock, findOne: jest.Mock };
const mockApiKey = ApiKeyModel as unknown as { create: jest.Mock, findOne: jest.Mock };
const mockInvite = InviteModel as unknown as { create: jest.Mock, findOne: jest.Mock, update: jest.Mock };
const mockSendMagicLink = sendMagicLinkEmail as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

// Each test uses a UNIQUE IP so the in-module per-IP rate limiters never bleed across tests.
let ipCounter = 0;
const nextIp = (): string => { ipCounter += 1; return `10.0.0.${ipCounter}`; };

const makeReq = (opts: { method?: string, body?: unknown, ip?: string } = {}): NextApiRequest => ({
   method: opts.method || 'POST',
   body: opts.body || {},
   query: {},
   headers: { 'x-forwarded-for': opts.ip || nextIp() },
   socket: { remoteAddress: opts.ip || '127.0.0.1' },
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
   process.env.MULTI_TENANT = 'true';
   delete process.env.RESEND_API_KEY;
   mockSendMagicLink.mockResolvedValue({ sent: false });
   // Default claim wins (1 row); race tests override.
   mockInvite.update.mockResolvedValue([1]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/auth/request-link', () => {
   it('404s when MULTI_TENANT is off and never touches the DB', async () => {
      process.env.MULTI_TENANT = 'false';
      const res = makeRes();
      await requestLinkHandler(makeReq({ body: { email: 'user@co.com' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
      expect(mockInvite.create).not.toHaveBeenCalled();
   });

   it('creates a login token + attempts a send + returns { sent: true } for an existing active email', async () => {
      mockAccount.findOne.mockResolvedValue({ ID: 7, email: 'user@co.com', status: 'active' });
      mockInvite.create.mockResolvedValue({ ID: 100, code: 'LOGINCODE' });
      const res = makeRes();
      await requestLinkHandler(makeReq({ body: { email: 'User@Co.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      // Lookup is by the normalized (lowercased) email.
      expect(mockAccount.findOne.mock.calls[0][0].where.email).toBe('user@co.com');
      // A single-use 'login' token targeting the account is created.
      const createArg = mockInvite.create.mock.calls[0][0];
      expect(createArg.type).toBe('login');
      expect(createArg.status).toBe('pending');
      expect(createArg.target_account_id).toBe(7);
      expect(createArg.email).toBe('user@co.com');
      expect(typeof createArg.code).toBe('string');
      // The magic-link send was attempted with a /auth/login?token= link carrying the SAME
      // generated code that was stored on the token row (the code is the credential).
      expect(mockSendMagicLink).toHaveBeenCalledTimes(1);
      expect(mockSendMagicLink.mock.calls[0][0].loginLink).toContain(`/auth/login?token=${createArg.code}`);
   });

   it('returns the SAME { sent: true } for an UNKNOWN email and creates NO token (non-leak)', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      const res = makeRes();
      await requestLinkHandler(makeReq({ body: { email: 'ghost@co.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      expect(mockInvite.create).not.toHaveBeenCalled();
      expect(mockSendMagicLink).not.toHaveBeenCalled();
   });

   it('does NOT create a token for an inactive account but still returns { sent: true }', async () => {
      mockAccount.findOne.mockResolvedValue({ ID: 8, email: 'paused@co.com', status: 'suspended' });
      const res = makeRes();
      await requestLinkHandler(makeReq({ body: { email: 'paused@co.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      expect(mockInvite.create).not.toHaveBeenCalled();
   });

   it('returns { sent: true } for a malformed email and never looks anything up', async () => {
      const res = makeRes();
      await requestLinkHandler(makeReq({ body: { email: 'not-an-email' } }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.sent).toBe(true);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });

   it('429s on the per-IP rate limit once exhausted', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      const ip = '10.9.9.9';
      let last = makeRes();
      // Default per-IP cap is 10; the 11th from the same IP is limited.
      for (let i = 0; i < 11; i += 1) {
         last = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await requestLinkHandler(makeReq({ ip, body: { email: `u${i}@co.com` } }), last);
      }
      expect(last.statusCode).toBe(429);
   });

   it('429s on the per-EMAIL rate limit even across different IPs', async () => {
      mockAccount.findOne.mockResolvedValue({ ID: 9, email: 'victim@co.com', status: 'active' });
      mockInvite.create.mockResolvedValue({ ID: 1, code: 'C' });
      let last = makeRes();
      // Default per-email cap is 3; the 4th for the same email (each from a fresh IP) is limited.
      for (let i = 0; i < 4; i += 1) {
         last = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await requestLinkHandler(makeReq({ ip: nextIp(), body: { email: 'victim@co.com' } }), last);
      }
      expect(last.statusCode).toBe(429);
   });
});

describe('POST /api/auth/verify-link', () => {
   const loginToken = (over: Record<string, unknown> = {}) => ({
      ID: 200,
      code: 'GOODLOGIN',
      type: 'login',
      status: 'pending',
      email: 'user@co.com',
      target_account_id: 7,
      get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      save: jest.fn(async () => undefined),
      ...over,
   });

   it('404s when MULTI_TENANT is off and never touches the DB', async () => {
      process.env.MULTI_TENANT = 'false';
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(404);
      expect(mockInvite.findOne).not.toHaveBeenCalled();
   });

   it('mints a FRESH ADMIN key ONCE for a valid login token and claims it pending -> used', async () => {
      mockInvite.findOne.mockResolvedValue(loginToken());
      mockAccount.findOne.mockResolvedValue({ ID: 7, status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 900 });
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.role).toBe('admin');
      expect(res.payload.accountId).toBe(7);
      const fullKey = res.payload.apiKey as string;
      expect(fullKey).toMatch(/^s33k_/);
      expect((res.payload.mcpConfig as { S33K_API_KEY: string }).S33K_API_KEY).toBe(fullKey);
      // Minted as an ADMIN key on the token's account; only prefix + hash persisted.
      const keyArg = mockApiKey.create.mock.calls[0][0];
      expect(keyArg.account_id).toBe(7);
      expect(keyArg.role).toBe('admin');
      expect(keyArg.key_prefix).toBe(fullKey.slice(0, 12));
      expect(Object.values(keyArg)).not.toContain(fullKey);
      // Claim-before-mint: guarded flip pending -> used, type-scoped to 'login'.
      expect(mockInvite.update).toHaveBeenCalledTimes(1);
      const [claimValues, claimOpts] = mockInvite.update.mock.calls[0];
      expect(claimValues.status).toBe('used');
      const where = (claimOpts as { where: { ID: number, status: string, type: string } }).where;
      expect(where.ID).toBe(200);
      expect(where.status).toBe('pending');
      expect(where.type).toBe('login');
   });

   it('rejects an empty token fast, before any DB read', async () => {
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: '   ' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockInvite.findOne).not.toHaveBeenCalled();
   });

   it('rejects an UNKNOWN token generically and never mints', async () => {
      mockInvite.findOne.mockResolvedValue(null);
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'nope' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });

   it('rejects a USED (non-pending) token generically and never mints', async () => {
      mockInvite.findOne.mockResolvedValue(loginToken({ status: 'used' }));
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });

   it('rejects an EXPIRED (>15m) token, lazily flips it to expired, and never mints', async () => {
      const longAgo = new Date(Date.now() - (16 * 60 * 1000)); // 16 min > 15-min TTL
      const expired = loginToken({ get: (k: string) => (k === 'createdAt' ? longAgo : undefined) });
      mockInvite.findOne.mockResolvedValue(expired);
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(expired.status).toBe('expired');
      expect(expired.save).toHaveBeenCalled();
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });

   it('rejects a NON-LOGIN invite code (type external) generically: the type guard', async () => {
      mockInvite.findOne.mockResolvedValue(loginToken({ type: 'external' }));
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
      // A non-login token must not even be claimed.
      expect(mockInvite.update).not.toHaveBeenCalled();
   });

   it('rejects when the target account is missing / inactive and never mints', async () => {
      mockInvite.findOne.mockResolvedValue(loginToken());
      mockAccount.findOne.mockResolvedValue({ ID: 7, status: 'suspended' });
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
      expect(mockInvite.update).not.toHaveBeenCalled();
   });

   it('rejects a CONCURRENT replay whose atomic claim loses (0 rows) and mints NOTHING', async () => {
      mockInvite.findOne.mockResolvedValue(loginToken());
      mockAccount.findOne.mockResolvedValue({ ID: 7, status: 'active' });
      mockInvite.update.mockResolvedValue([0]); // claim lost
      const res = makeRes();
      await verifyLinkHandler(makeReq({ body: { token: 'GOODLOGIN' } }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired link.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/invite/accept acceptExternal: email stamping + collision', () => {
   const externalInvite = {
      ID: 300,
      code: 'GOODEXT',
      type: 'external',
      status: 'pending',
      email: 'founder@newco.com',
      target_account_id: null,
      get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
   };

   it('stamps account.email from the invite and stays race-safe (claim-before-mint)', async () => {
      mockInvite.findOne.mockResolvedValue(externalInvite);
      mockAccount.create.mockResolvedValue({ ID: 99, status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 500 });
      const res = makeRes();
      await acceptHandler(makeReq({ body: { code: 'GOODEXT', name: 'New Co' } }), res);

      expect(res.statusCode).toBe(201);
      // The new account carries the invite's (normalized) email.
      expect(mockAccount.create).toHaveBeenCalledTimes(1);
      expect(mockAccount.create.mock.calls[0][0].email).toBe('founder@newco.com');
      // Claim-before-mint still fires (status flip then stamp).
      expect(mockInvite.update).toHaveBeenCalledTimes(2);
      expect(mockInvite.update.mock.calls[0][0].status).toBe('accepted');
   });

   it('retries WITHOUT email on a unique collision and still succeeds (no 500)', async () => {
      mockInvite.findOne.mockResolvedValue(externalInvite);
      // First create throws a unique-constraint error (email already owned); retry succeeds.
      mockAccount.create
         .mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'SequelizeUniqueConstraintError' }))
         .mockResolvedValueOnce({ ID: 101, status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 501 });
      const res = makeRes();
      await acceptHandler(makeReq({ body: { code: 'GOODEXT', name: 'New Co' } }), res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.accountId).toBe(101);
      // Two create attempts: the first with email, the retry with email null.
      expect(mockAccount.create).toHaveBeenCalledTimes(2);
      expect(mockAccount.create.mock.calls[0][0].email).toBe('founder@newco.com');
      expect(mockAccount.create.mock.calls[1][0].email).toBeNull();
      // A working key was still minted.
      expect(mockApiKey.create).toHaveBeenCalledTimes(1);
   });
});
