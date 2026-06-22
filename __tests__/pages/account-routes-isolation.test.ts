/**
 * Adversarial cross-tenant isolation tests for the account-management routes
 * (pages/api/account.ts, pages/api/account-key.ts, pages/api/me.ts).
 *
 * SECURITY-CRITICAL contract under test (with MULTI_TENANT = 'true'):
 *   1. POST/GET /api/account are ADMIN-only. A non-admin account is 403'd and never
 *      reaches the Account/ApiKey models (no create, no list).
 *   2. POST /api/account-key: admin may mint for any account; a tenant may mint ONLY for
 *      its own account_id. Minting for ANOTHER account is 403'd before any DB write.
 *   3. DELETE /api/account-key: admin may revoke any key; a tenant may revoke ONLY its own
 *      keys. Targeting another account's key returns 404 (existence not leaked) and never
 *      writes revoked_at.
 *   4. GET /api/me returns the CALLER's own account, never another account's.
 *   5. Mints return the full key exactly once and persist only prefix + hash, never the
 *      clear key.
 *
 * The DB layer (database/database) is mocked to a no-op sync, and the Account/ApiKey
 * models are mocked so every call is a pure assertion on what the route attempted. authorize
 * is mocked per-test to inject the calling account, isolating the route's own gate logic.
 * No network, no DB.
 */

// db.sync() is a no-op; ensureAdminAccount's findOrCreate is stubbed via the Account mock.
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// The model + authorize mocks are declared via factories (hoisted above any const), then
// retrieved through the mocked default exports below so per-test assertions can inspect them.
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: {
      create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), findOrCreate: jest.fn(),
   },
}));
jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { create: jest.fn(), findAll: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
// recordAudit imports the AuditLog sequelize model; mock to a no-op (best-effort/non-blocking write).
// The isolation contract under test (cross-account mint/revoke refused, admin gate) is unchanged by it.
jest.mock('../../utils/auditLog', () => ({ __esModule: true, recordAudit: jest.fn(async () => undefined), default: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import accountHandler from '../../pages/api/account';
// eslint-disable-next-line import/first
import accountKeyHandler from '../../pages/api/account-key';
// eslint-disable-next-line import/first
import meHandler from '../../pages/api/me';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockAccount = AccountModel as unknown as {
   create: jest.Mock, findAll: jest.Mock, findOne: jest.Mock, findOrCreate: jest.Mock,
};
const mockApiKey = ApiKeyModel as unknown as { create: jest.Mock, findAll: jest.Mock, findOne: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };
const TENANT_B = { ID: 3, name: 'Tenant B', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

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
   mockAccount.findOrCreate.mockResolvedValue([{ ID: 1 }, false]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/account (admin-only)', () => {
   it('lets the admin create an account and mints one key, returning the full key once', async () => {
      asCaller(ADMIN);
      mockAccount.create.mockResolvedValue({ ID: 10, name: 'New Co', plan: 'free', status: 'active' });
      mockApiKey.create.mockResolvedValue({ ID: 100 });
      const req = makeReq({ method: 'POST', body: { name: 'New Co' } });
      const res = makeRes() as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };

      await accountHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.account).toMatchObject({ ID: 10, name: 'New Co' });
      const fullKey = res.payload.apiKey as string;
      expect(fullKey).toMatch(/^s33k_/);
      // Only prefix + hash are persisted; the clear key never is.
      const createArg = mockApiKey.create.mock.calls[0][0];
      expect(createArg.key_hash).not.toContain(fullKey);
      expect(createArg.key_prefix).toBe(fullKey.slice(0, 12));
      expect(Object.values(createArg)).not.toContain(fullKey);
   });

   it('403s a NON-admin tenant and never touches the Account model', async () => {
      asCaller(TENANT_A);
      const req = makeReq({ method: 'POST', body: { name: 'Sneaky Co' } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockAccount.create).not.toHaveBeenCalled();
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });
});

describe('GET /api/account (admin-only)', () => {
   it('403s a non-admin tenant and never lists accounts', async () => {
      asCaller(TENANT_B);
      const req = makeReq({ method: 'GET' });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockAccount.findAll).not.toHaveBeenCalled();
   });
});

describe('POST /api/account-key (admin or self only)', () => {
   it('lets a tenant mint a key for ITS OWN account', async () => {
      asCaller(TENANT_A);
      mockAccount.findOne.mockResolvedValue(TENANT_A);
      mockApiKey.create.mockResolvedValue({ ID: 200 });
      const req = makeReq({ method: 'POST', body: { account_id: TENANT_A.ID } });
      const res = makeRes() as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.payload.apiKey as string).toMatch(/^s33k_/);
      expect(mockApiKey.create.mock.calls[0][0].account_id).toBe(TENANT_A.ID);
   });

   it('403s a tenant minting a key for ANOTHER account and never writes', async () => {
      asCaller(TENANT_A);
      const req = makeReq({ method: 'POST', body: { account_id: TENANT_B.ID } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(403);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
      expect(mockApiKey.create).not.toHaveBeenCalled();
   });

   it('lets the admin mint a key for any account', async () => {
      asCaller(ADMIN);
      mockAccount.findOne.mockResolvedValue(TENANT_B);
      mockApiKey.create.mockResolvedValue({ ID: 201 });
      const req = makeReq({ method: 'POST', body: { account_id: TENANT_B.ID } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(201);
      expect(mockApiKey.create.mock.calls[0][0].account_id).toBe(TENANT_B.ID);
   });
});

describe('DELETE /api/account-key (admin or owner only)', () => {
   it('lets a tenant revoke its OWN key', async () => {
      asCaller(TENANT_A);
      const keyRow = { ID: 50, account_id: TENANT_A.ID, revoked_at: null, save: jest.fn(async () => undefined) };
      mockApiKey.findOne.mockResolvedValue(keyRow);
      const req = makeReq({ method: 'DELETE', query: { id: '50' } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(keyRow.revoked_at).toBeInstanceOf(Date);
      expect(keyRow.save).toHaveBeenCalled();
   });

   it('404s a tenant revoking ANOTHER account\'s key and never sets revoked_at', async () => {
      asCaller(TENANT_A);
      const otherKey = { ID: 51, account_id: TENANT_B.ID, revoked_at: null, save: jest.fn(async () => undefined) };
      mockApiKey.findOne.mockResolvedValue(otherKey);
      const req = makeReq({ method: 'DELETE', query: { id: '51' } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(404);
      expect(otherKey.revoked_at).toBeNull();
      expect(otherKey.save).not.toHaveBeenCalled();
   });

   it('lets the admin revoke any account\'s key', async () => {
      asCaller(ADMIN);
      const otherKey = { ID: 52, account_id: TENANT_B.ID, revoked_at: null, save: jest.fn(async () => undefined) };
      mockApiKey.findOne.mockResolvedValue(otherKey);
      const req = makeReq({ method: 'DELETE', query: { id: '52' } });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await accountKeyHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(otherKey.save).toHaveBeenCalled();
   });
});

describe('GET /api/me', () => {
   it('returns the CALLER\'s own tenant account, not another account', async () => {
      asCaller(TENANT_B);
      const req = makeReq({ method: 'GET' });
      const res = makeRes() as NextApiResponse & { payload: Record<string, unknown> };

      await meHandler(req, res);

      expect(res.payload.account).toMatchObject({ ID: TENANT_B.ID, name: 'Tenant B', plan: 'free', status: 'active' });
   });

   it('hydrates the bare admin sentinel with admin defaults', async () => {
      asCaller({ ID: ADMIN_ACCOUNT_ID });
      const req = makeReq({ method: 'GET' });
      const res = makeRes() as NextApiResponse & { payload: Record<string, unknown> };

      await meHandler(req, res);

      expect(res.payload.account).toMatchObject({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' });
   });
});
