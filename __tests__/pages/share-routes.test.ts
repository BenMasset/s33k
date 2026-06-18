import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Behavioral + adversarial tests for the per-domain SHARE routes (pages/api/share.ts) with
 * MULTI_TENANT = 'true'.
 *
 * Contracts under test:
 *   POST /api/share { domain, email? } (authed admin):
 *     1. Requires domain write-ownership: a domain the caller does NOT own is 403'd and NO key
 *        is minted (resolveDomainAccess(account, domain, { write: true }) returns null).
 *     2. An owned domain mints a NEW api_key with role 'member' and scoped_domain = domain, on
 *        the OWNER account, and returns the full key once plus an mcpConfig and instruction.
 *     3. A read-only MEMBER key is rejected before the route (authorize 401).
 *   GET /api/share?domain= (owner): lists shares for an OWNED domain; a non-owner is 403'd.
 *   DELETE /api/share?id= (owner): revokes ONLY a share whose scoped_domain the caller owns; a
 *     foreign or non-share key returns 404 (no existence leak) and nothing is revoked.
 *
 * No network, no DB: database/database is a no-op, the models + authorize + resolveDomainAccess +
 * send-invite are jest mocks.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));
jest.mock('../../utils/ensureAdminAccount', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));

// resolveAccount (imported transitively for the key-mint helpers) pulls in the Account model;
// mock it so jest never transforms sequelize's ESM uuid chain. The mint helpers themselves are
// pure crypto and run for real, so the minted key shape is genuinely asserted.
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domain-access', () => ({ __esModule: true, default: jest.fn() }));
// send-invite must never touch the network; stub it to a no-send result.
jest.mock('../../utils/send-invite', () => ({
   __esModule: true,
   sendInviteEmail: jest.fn(async () => ({ sent: false })),
   default: jest.fn(async () => ({ sent: false })),
}));

// eslint-disable-next-line import/first
import shareHandler from '../../pages/api/share';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import resolveDomainAccessFn from '../../utils/domain-access';
// eslint-disable-next-line import/first
import { sendInviteEmail } from '../../utils/send-invite';

const mockApiKey = ApiKeyModel as unknown as { create: jest.Mock, findOne: jest.Mock, findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockResolveDomainAccess = resolveDomainAccessFn as unknown as jest.Mock;
const mockSendInvite = sendInviteEmail as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', status: 'active' };
const TENANT_B = { ID: 3, name: 'Tenant B', status: 'active' };

const asCaller = (account: unknown, role: 'admin' | 'member' = 'admin') => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role });
};
const asRejectedMemberWrite = () => {
   mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Read-only member' });
};

const makeReq = (opts: { method?: string, body?: unknown, query?: Record<string, string> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body || {},
   query: opts.query || {},
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
   process.env.NEXT_PUBLIC_APP_URL = 'https://s33k.example';
   mockSendInvite.mockResolvedValue({ sent: false });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/share (mint a share key)', () => {
   it('403s and mints NOTHING when the caller does not own the domain', async () => {
      asCaller(TENANT_B);
      mockResolveDomainAccess.mockResolvedValue(null); // B does not own tenant-a.com
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(403);
      expect(mockApiKey.create).not.toHaveBeenCalled();
      // The ownership check ran as a WRITE gate.
      expect(mockResolveDomainAccess).toHaveBeenCalledWith(TENANT_B, 'tenant-a.com', { write: true });
   });

   it('mints a member+scoped key on the OWNER account for an owned domain', async () => {
      asCaller(TENANT_A);
      mockResolveDomainAccess.mockResolvedValue({ ID: 9, domain: 'tenant-a.com', owner_id: TENANT_A.ID });
      mockApiKey.create.mockResolvedValue({ ID: 500 });
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(201);
      const createArg = mockApiKey.create.mock.calls[0][0];
      expect(createArg.role).toBe('member');
      expect(createArg.scoped_domain).toBe('tenant-a.com');
      expect(createArg.account_id).toBe(TENANT_A.ID);
      // The full key is returned ONCE, with an mcpConfig and a human instruction.
      expect(typeof res.payload.apiKey).toBe('string');
      expect((res.payload.apiKey as string).startsWith('s33k_')).toBe(true);
      expect(res.payload.scopedDomain).toBe('tenant-a.com');
      const mcp = res.payload.mcpConfig as { S33K_BASE_URL: string, S33K_API_KEY: string };
      expect(mcp.S33K_BASE_URL).toBe('https://s33k.example');
      expect(mcp.S33K_API_KEY).toBe(res.payload.apiKey);
      expect(typeof res.payload.instruction).toBe('string');
   });

   it('mints on the admin account (owner_id null) when an admin-owned domain is shared', async () => {
      asCaller(ADMIN);
      mockResolveDomainAccess.mockResolvedValue({ ID: 1, domain: 'getmasset.com', owner_id: null });
      mockApiKey.create.mockResolvedValue({ ID: 501 });
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(201);
      // owner_id null -> falls back to the acting admin account id.
      expect(mockApiKey.create.mock.calls[0][0].account_id).toBe(ADMIN_ACCOUNT_ID);
   });

   it('best-effort emails the collaborator when an email is given (never blocks)', async () => {
      asCaller(TENANT_A);
      mockResolveDomainAccess.mockResolvedValue({ ID: 9, domain: 'tenant-a.com', owner_id: TENANT_A.ID });
      mockApiKey.create.mockResolvedValue({ ID: 502 });
      mockSendInvite.mockResolvedValue({ sent: true });
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: { domain: 'tenant-a.com', email: 'client@acme.com' } }), res);

      expect(res.statusCode).toBe(201);
      expect(mockSendInvite).toHaveBeenCalledWith(expect.objectContaining({
         to: 'client@acme.com', type: 'share', domain: 'tenant-a.com',
      }));
      expect(res.payload.emailSent).toBe(true);
   });

   it('400s when no domain is given', async () => {
      asCaller(TENANT_A);
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: {} }), res);

      expect(res.statusCode).toBe(400);
      expect(mockResolveDomainAccess).not.toHaveBeenCalled();
   });

   it('a read-only member key is rejected before the route (authorize 401)', async () => {
      asRejectedMemberWrite();
      const res = makeRes();

      await shareHandler(makeReq({ method: 'POST', body: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(401);
      expect(mockResolveDomainAccess).not.toHaveBeenCalled();
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });
});

describe('GET /api/share (list shares for an owned domain)', () => {
   it('403s when the caller does not own the domain', async () => {
      asCaller(TENANT_B);
      mockResolveDomainAccess.mockResolvedValue(null);
      const res = makeRes();

      await shareHandler(makeReq({ method: 'GET', query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(403);
      expect(mockApiKey.findAll).not.toHaveBeenCalled();
   });

   it('lists shares scoped to the owned domain', async () => {
      asCaller(TENANT_A);
      mockResolveDomainAccess.mockResolvedValue({ ID: 9, domain: 'tenant-a.com', owner_id: TENANT_A.ID });
      mockApiKey.findAll.mockResolvedValue([
         {
            ID: 500, key_prefix: 's33k_abcdefg', name: 'share:client@acme.com', scoped_domain: 'tenant-a.com',
            last_used_at: null, revoked_at: null, get: () => null,
         },
      ]);
      const res = makeRes();

      await shareHandler(makeReq({ method: 'GET', query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockApiKey.findAll.mock.calls[0][0].where).toEqual({ scoped_domain: 'tenant-a.com' });
      const shares = res.payload.shares as Array<{ ID: number, revoked: boolean }>;
      expect(shares[0].ID).toBe(500);
      expect(shares[0].revoked).toBe(false);
   });
});

describe('DELETE /api/share (revoke a share)', () => {
   it('revokes a share whose domain the caller owns', async () => {
      asCaller(TENANT_A);
      const save = jest.fn(async () => undefined);
      mockApiKey.findOne.mockResolvedValue({ ID: 500, scoped_domain: 'tenant-a.com', revoked_at: null, save });
      mockResolveDomainAccess.mockResolvedValue({ ID: 9, domain: 'tenant-a.com', owner_id: TENANT_A.ID });
      const res = makeRes();

      await shareHandler(makeReq({ method: 'DELETE', query: { id: '500' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.revoked).toBe(true);
      expect(save).toHaveBeenCalled();
   });

   it('404s (no existence leak) and revokes NOTHING when the share is on a domain the caller does not own', async () => {
      asCaller(TENANT_B);
      const save = jest.fn(async () => undefined);
      // The key exists and is a share, but it is scoped to tenant-a.com which B does not own.
      mockApiKey.findOne.mockResolvedValue({ ID: 500, scoped_domain: 'tenant-a.com', revoked_at: null, save });
      mockResolveDomainAccess.mockResolvedValue(null); // B does not own tenant-a.com
      const res = makeRes();

      await shareHandler(makeReq({ method: 'DELETE', query: { id: '500' } }), res);

      expect(res.statusCode).toBe(404);
      expect(save).not.toHaveBeenCalled();
   });

   it('404s when the targeted key is not a share key (scoped_domain null)', async () => {
      asCaller(TENANT_A);
      const save = jest.fn(async () => undefined);
      mockApiKey.findOne.mockResolvedValue({ ID: 77, scoped_domain: null, revoked_at: null, save });
      const res = makeRes();

      await shareHandler(makeReq({ method: 'DELETE', query: { id: '77' } }), res);

      expect(res.statusCode).toBe(404);
      expect(mockResolveDomainAccess).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
   });

   it('400s when no id is given', async () => {
      asCaller(TENANT_A);
      const res = makeRes();

      await shareHandler(makeReq({ method: 'DELETE', query: {} }), res);

      expect(res.statusCode).toBe(400);
      expect(mockApiKey.findOne).not.toHaveBeenCalled();
   });
});
