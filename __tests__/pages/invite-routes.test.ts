import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral tests for the invite system routes (pages/api/invite.ts and
 * pages/api/invite/accept.ts) with MULTI_TENANT = 'true'.
 *
 * Contracts under test:
 *   POST /api/invite (authed admin):
 *     1. EXTERNAL invites are quota-limited per inviter. Creation is allowed while the
 *        account's outstanding+accepted external invite count is below external_invite_quota,
 *        and 403'd once the count reaches the quota. Enforcement is by COUNTING (no racy
 *        counter mutation), so the route calls Invite.count and compares to the quota.
 *     2. INTERNAL invites are UNLIMITED: no count/quota check, target_account_id is the
 *        caller's own account, and the invite is created regardless of how many exist.
 *     3. A read-only MEMBER key is 403'd even on this POST (admins-only).
 *
 *   POST /api/invite/accept (PUBLIC, the code is the credential):
 *     4. An EXTERNAL invite mints a NEW admin account + an ADMIN api_key, returns the full
 *        key once, and marks the invite accepted (single-use).
 *     5. An INTERNAL invite mints a read-only MEMBER api_key (role 'member') on the invite's
 *        target_account_id and marks it accepted.
 *     6. An invalid / already-used (non-pending) / expired code is rejected with the single
 *        generic message and NEVER mints a key or creates an account.
 *
 * No network, no DB: database/database is a no-op, the models are jest mocks, authorize is
 * mocked per-test to inject the caller, and send-invite is mocked so no email is sent.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// Stub sequelize so importing the route does not pull the untransformed ESM uuid chain in via
// `import { Op } from 'sequelize'`. The route only uses Op.in; a Symbol stand-in is enough.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: {
      create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), findOrCreate: jest.fn(),
   },
}));
jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../database/models/invite', () => ({
   __esModule: true,
   default: {
      create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), count: jest.fn(), update: jest.fn(),
   },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
// send-invite must never touch the network; stub it to a no-send result.
jest.mock('../../utils/send-invite', () => ({
   __esModule: true,
   sendInviteEmail: jest.fn(async () => ({ sent: false })),
   default: jest.fn(async () => ({ sent: false })),
}));

// eslint-disable-next-line import/first
import inviteHandler from '../../pages/api/invite';
// eslint-disable-next-line import/first
import acceptHandler from '../../pages/api/invite/accept';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import InviteModel from '../../database/models/invite';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { sendInviteEmail } from '../../utils/send-invite';

const mockAccount = AccountModel as unknown as {
   create: jest.Mock, findAll: jest.Mock, findOne: jest.Mock, findOrCreate: jest.Mock,
};
const mockApiKey = ApiKeyModel as unknown as { create: jest.Mock, findOne: jest.Mock };
const mockInvite = InviteModel as unknown as {
   create: jest.Mock, findAll: jest.Mock, findOne: jest.Mock, count: jest.Mock, update: jest.Mock,
};
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockSendInvite = sendInviteEmail as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = {
   ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active', external_invite_quota: 5,
};
const TENANT_A = {
   ID: 2, name: 'Tenant A', plan: 'free', status: 'active', external_invite_quota: 3,
};

// Inject the calling account + role into the mocked authorize().
const asCaller = (account: unknown, role: 'admin' | 'member' = 'admin') => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role });
};

const makeReq = (opts: { method?: string, body?: unknown, headers?: Record<string, string> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body || {},
   query: {},
   headers: opts.headers || {},
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
   process.env.MULTI_TENANT = 'true';
   delete process.env.RESEND_API_KEY;
   mockAccount.findOrCreate.mockResolvedValue([{ ID: ADMIN_ACCOUNT_ID }, false]);
   mockSendInvite.mockResolvedValue({ sent: false });
   // accept.ts claims an invite with a guarded conditional update that returns [affected].
   // Default to a winning claim (1 row); the race test overrides this to [0].
   mockInvite.update.mockResolvedValue([1]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/invite: external invite quota enforcement', () => {
   it('ALLOWS an external invite while under the quota and creates a pending external invite', async () => {
      asCaller(TENANT_A); // quota 3
      mockInvite.count.mockResolvedValue(2); // 2 used < 3
      mockInvite.create.mockResolvedValue({ ID: 10, code: 'EXTCODE10', type: 'external', email: 'new@co.com' });
      const req = makeReq({ method: 'POST', body: { type: 'external', email: 'new@co.com' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.type).toBe('external');
      expect(res.payload.code).toBe('EXTCODE10');
      // Quota enforced by COUNTING this account's outstanding+accepted external invites.
      expect(mockInvite.count).toHaveBeenCalledTimes(1);
      const countWhere = (mockInvite.count.mock.calls[0][0] as { where: Record<string, unknown> }).where;
      expect(countWhere.inviter_account_id).toBe(TENANT_A.ID);
      expect(countWhere.type).toBe('external');
      const createArg = mockInvite.create.mock.calls[0][0];
      expect(createArg.type).toBe('external');
      expect(createArg.status).toBe('pending');
      expect(createArg.inviter_account_id).toBe(TENANT_A.ID);
      // External invites have no account yet.
      expect(createArg.target_account_id).toBeNull();
   });

   it('ALLOWS the final external invite at exactly quota - 1 used', async () => {
      asCaller(TENANT_A); // quota 3
      mockInvite.count.mockResolvedValue(2); // 2 used, room for 1 more
      mockInvite.create.mockResolvedValue({ ID: 11, code: 'EXTCODE11', type: 'external', email: 'last@co.com' });
      const req = makeReq({ method: 'POST', body: { type: 'external', email: 'last@co.com' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(mockInvite.create).toHaveBeenCalledTimes(1);
   });

   it('403s the external invite once the quota is reached and NEVER creates an invite', async () => {
      asCaller(TENANT_A); // quota 3
      mockInvite.count.mockResolvedValue(3); // 3 used >= 3
      const req = makeReq({ method: 'POST', body: { type: 'external', email: 'over@co.com' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/quota/i);
      expect(mockInvite.create).not.toHaveBeenCalled();
   });

   it('403s the external invite when the count exceeds the quota and NEVER creates an invite', async () => {
      asCaller(TENANT_A); // quota 3
      mockInvite.count.mockResolvedValue(5); // already over
      const req = makeReq({ method: 'POST', body: { type: 'external', email: 'way-over@co.com' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockInvite.create).not.toHaveBeenCalled();
   });
});

describe('POST /api/invite: internal invites are unlimited', () => {
   it('creates an internal invite WITHOUT any quota/count check, targeting the caller account', async () => {
      asCaller(ADMIN);
      mockInvite.create.mockResolvedValue({ ID: 20, code: 'INTCODE20', type: 'internal', email: null });
      const req = makeReq({ method: 'POST', body: { type: 'internal' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.type).toBe('internal');
      // Internal invites are unlimited: the quota count is never consulted.
      expect(mockInvite.count).not.toHaveBeenCalled();
      const createArg = mockInvite.create.mock.calls[0][0];
      expect(createArg.type).toBe('internal');
      expect(createArg.target_account_id).toBe(ADMIN.ID);
      expect(createArg.status).toBe('pending');
   });

   it('creates many internal invites for the same account, none gated', async () => {
      asCaller(TENANT_A);
      mockInvite.create.mockImplementation(async (arg: { type: string }) => ({ ID: 30, code: 'INT', ...arg }));
      for (let i = 0; i < 10; i += 1) {
         // eslint-disable-next-line no-await-in-loop
         const res = makeRes();
         // eslint-disable-next-line no-await-in-loop
         await inviteHandler(makeReq({ method: 'POST', body: { type: 'internal' } }), res);
         expect(res.statusCode).toBe(201);
      }
      expect(mockInvite.create).toHaveBeenCalledTimes(10);
      expect(mockInvite.count).not.toHaveBeenCalled();
   });
});

describe('POST /api/invite: member keys are rejected (admins-only)', () => {
   it('403s a read-only MEMBER key on the create POST and never creates an invite', async () => {
      asCaller(TENANT_A, 'member');
      const req = makeReq({ method: 'POST', body: { type: 'internal' } });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/member/i);
      expect(mockInvite.create).not.toHaveBeenCalled();
      expect(mockInvite.count).not.toHaveBeenCalled();
   });

   it('403s a read-only MEMBER key on the list GET and never lists invites', async () => {
      asCaller(TENANT_A, 'member');
      const req = makeReq({ method: 'GET' });
      const res = makeRes();

      await inviteHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockInvite.findAll).not.toHaveBeenCalled();
   });
});

describe('POST /api/invite/accept: external mints an admin account + admin key', () => {
   it('mints a NEW admin account + ADMIN key, returns the full key once, marks the invite accepted', async () => {
      mockInvite.findOne.mockResolvedValue({
         ID: 40,
         code: 'GOODEXT',
         type: 'external',
         status: 'pending',
         email: 'founder@newco.com',
         target_account_id: null,
         get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      });
      mockAccount.create.mockResolvedValue({ ID: 99, name: 'New Co', plan: 'free', status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 500 });
      const req = makeReq({ method: 'POST', body: { code: 'GOODEXT', name: 'New Co' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.role).toBe('admin');
      expect(res.payload.accountId).toBe(99);
      const fullKey = res.payload.apiKey as string;
      expect(fullKey).toMatch(/^s33k_/);
      // The MCP config carries the same full key once.
      expect((res.payload.mcpConfig as { S33K_API_KEY: string }).S33K_API_KEY).toBe(fullKey);
      // A brand-new account was created and the minted key is an admin key on it.
      expect(mockAccount.create).toHaveBeenCalledTimes(1);
      const keyArg = mockApiKey.create.mock.calls[0][0];
      expect(keyArg.account_id).toBe(99);
      expect(keyArg.role).toBe('admin');
      // Only prefix + hash are persisted, never the clear key.
      expect(keyArg.key_prefix).toBe(fullKey.slice(0, 12));
      expect(Object.values(keyArg)).not.toContain(fullKey);
      // Single-use: the invite is CLAIMED first with a guarded conditional update (status flips
      // pending -> accepted only while still pending), then the consuming account is stamped in.
      expect(mockInvite.update).toHaveBeenCalledTimes(2);
      const [claimValues, claimOpts] = mockInvite.update.mock.calls[0];
      expect(claimValues.status).toBe('accepted');
      expect((claimOpts as { where: { ID: number, status: string } }).where.ID).toBe(40);
      expect((claimOpts as { where: { ID: number, status: string } }).where.status).toBe('pending');
      const [stampValues, stampOpts] = mockInvite.update.mock.calls[1];
      expect(stampValues.accepted_by_account_id).toBe(99);
      expect((stampOpts as { where: { ID: number } }).where.ID).toBe(40);
   });
});

describe('POST /api/invite/accept: internal mints a read-only member key', () => {
   it('mints a MEMBER key on the invite target_account_id and marks the invite accepted', async () => {
      mockInvite.findOne.mockResolvedValue({
         ID: 41,
         code: 'GOODINT',
         type: 'internal',
         status: 'pending',
         email: null,
         target_account_id: 2,
         get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      });
      mockAccount.findOne.mockResolvedValue({ ID: 2, name: 'Tenant A', status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 501 });
      const req = makeReq({ method: 'POST', body: { code: 'GOODINT', name: 'Teammate' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.role).toBe('member');
      expect(res.payload.accountId).toBe(2);
      const fullKey = res.payload.apiKey as string;
      expect(fullKey).toMatch(/^s33k_/);
      // No new account is created for an internal seat; the key is a MEMBER key on the target.
      expect(mockAccount.create).not.toHaveBeenCalled();
      const keyArg = mockApiKey.create.mock.calls[0][0];
      expect(keyArg.account_id).toBe(2);
      expect(keyArg.role).toBe('member');
      // Single-use: claim (guarded flip) then stamp the consuming account.
      expect(mockInvite.update).toHaveBeenCalledTimes(2);
      const [claimValues, claimOpts] = mockInvite.update.mock.calls[0];
      expect(claimValues.status).toBe('accepted');
      expect((claimOpts as { where: { status: string } }).where.status).toBe('pending');
      const [stampValues] = mockInvite.update.mock.calls[1];
      expect(stampValues.accepted_by_account_id).toBe(2);
   });
});

describe('POST /api/invite/accept: invalid / used / expired codes are rejected', () => {
   it('rejects an UNKNOWN code generically and never mints a key or account', async () => {
      mockInvite.findOne.mockResolvedValue(null);
      const req = makeReq({ method: 'POST', body: { code: 'does-not-exist' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired invite code.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
      expect(mockAccount.create).not.toHaveBeenCalled();
      expect(mockInvite.update).not.toHaveBeenCalled();
   });

   it('rejects an ALREADY-USED (non-pending) code generically and never mints', async () => {
      mockInvite.findOne.mockResolvedValue({
         ID: 42,
         code: 'USED',
         type: 'external',
         status: 'accepted', // already consumed
         email: 'x@y.com',
         target_account_id: null,
         get: () => new Date(),
      });
      const req = makeReq({ method: 'POST', body: { code: 'USED' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired invite code.');
      expect(mockApiKey.create).not.toHaveBeenCalled();
      expect(mockAccount.create).not.toHaveBeenCalled();
   });

   it('rejects an EXPIRED (past TTL) code generically, flips it to expired, and never mints', async () => {
      const longAgo = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)); // 31 days > 30-day TTL
      const expiredInvite = {
         ID: 43,
         code: 'STALE',
         type: 'external',
         status: 'pending',
         email: 'x@y.com',
         target_account_id: null,
         get: (k: string) => (k === 'createdAt' ? longAgo : undefined),
         save: jest.fn(async () => undefined),
      };
      mockInvite.findOne.mockResolvedValue(expiredInvite);
      const req = makeReq({ method: 'POST', body: { code: 'STALE' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired invite code.');
      // Lazily flips status to expired.
      expect(expiredInvite.status).toBe('expired');
      expect(expiredInvite.save).toHaveBeenCalled();
      // No key or account ever minted for an expired code.
      expect(mockApiKey.create).not.toHaveBeenCalled();
      expect(mockAccount.create).not.toHaveBeenCalled();
   });

   it('rejects a CONCURRENT replay whose atomic claim loses (0 rows) and never mints', async () => {
      // Two requests race the same pending external code. findOne sees pending for both, but the
      // guarded claim update affects 0 rows for the loser. The loser must reject generically and
      // mint nothing: no account, no key, no stamp.
      mockInvite.findOne.mockResolvedValue({
         ID: 44,
         code: 'RACED',
         type: 'external',
         status: 'pending',
         email: 'race@co.com',
         target_account_id: null,
         get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      });
      mockInvite.update.mockResolvedValue([0]); // claim lost
      const req = makeReq({ method: 'POST', body: { code: 'RACED' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired invite code.');
      expect(mockAccount.create).not.toHaveBeenCalled();
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });

   it('rejects an empty code fast, before any DB read', async () => {
      const req = makeReq({ method: 'POST', body: { code: '   ' } });
      const res = makeRes();

      await acceptHandler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toBe('Invalid or expired invite code.');
      expect(mockInvite.findOne).not.toHaveBeenCalled();
   });
});
