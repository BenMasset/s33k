import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Phase 3 scale test: the api_key.last_used_at write is THROTTLED.
 *
 * Before this change, every authorized per-account-key request wrote api_key (read amplified into
 * a read + write). resolveAccount now refreshes last_used_at at most once per LAST_USED_THROTTLE_MS.
 * This suite drives the MULTI_TENANT-on per-account-key path (the only path that writes last_used_at)
 * with two rapid resolutions of the SAME key and asserts the row is saved AT MOST ONCE, and that
 * auth still succeeds either way (the write is best-effort and must never gate authorization).
 *
 * It mocks the Account + ApiKey models so there is no DB or network. The candidate row is a single
 * shared stateful object whose `save()` stamps last_used_at and counts calls, mirroring the real
 * model just enough to exercise the throttle window.
 */

// A single shared candidate api_key row, reset per test. save() is the write we count; it stamps
// last_used_at exactly as the real sequelize instance would, so the throttle's "has it been written
// recently" check sees the update on the next resolution.
const candidate: { key_hash: string, last_used_at: Date | null, scoped_domain: string | null, role: string, account_id: number, save: jest.Mock } = {
   key_hash: '',
   last_used_at: null,
   scoped_domain: null,
   role: 'admin',
   account_id: 2,
   save: jest.fn(),
};

jest.mock('../../database/models/apiKey', () => ({
   __esModule: true,
   default: { findOne: jest.fn(async () => candidate) },
}));
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: { findOne: jest.fn(async () => ({ ID: 2, status: 'active' })) },
}));

// eslint-disable-next-line import/first
import resolveAccount, { hashApiKey } from '../../utils/resolveAccount';

const ORIGINAL_ENV = { ...process.env };

const TENANT_KEY = 's33k_tenant_key_fixture_value_1234567890';

const makeReq = (bearer: string): NextApiRequest => (
   { headers: { authorization: `Bearer ${bearer}` } } as unknown as NextApiRequest
);
const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

describe('resolveAccount last_used_at throttle (MULTI_TENANT on)', () => {
   beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      process.env.APIKEY = 's33k_legacy_admin_key';
      process.env.SECRET = 'unit-test-secret';
      process.env.MULTI_TENANT = 'true';
      delete process.env.LAST_USED_THROTTLE_MS;
      // Reset the shared candidate to a fresh, never-used key whose hash matches TENANT_KEY.
      candidate.key_hash = hashApiKey(TENANT_KEY);
      candidate.last_used_at = null;
      candidate.scoped_domain = null;
      candidate.role = 'admin';
      candidate.account_id = 2;
      candidate.save.mockReset();
      // The real save() stamps last_used_at (set in resolveAccount just before save) and resolves,
      // so the second resolution sees a recent timestamp and skips the write.
      candidate.save.mockImplementation(async () => candidate);
   });

   afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
   });

   it('writes api_key at most once across two rapid authed resolutions of the same key', async () => {
      const first = await resolveAccount(makeReq(TENANT_KEY), makeRes());
      expect(first.authorized).toBe(true);
      expect(first.account!.ID).toBe(2);
      // First resolution stamped last_used_at and saved (it had never been used).
      expect(candidate.save).toHaveBeenCalledTimes(1);
      expect(candidate.last_used_at).not.toBeNull();

      const second = await resolveAccount(makeReq(TENANT_KEY), makeRes());
      expect(second.authorized).toBe(true);
      expect(second.account!.ID).toBe(2);
      // Second resolution is within the (default 5 min) throttle window, so NO additional write.
      expect(candidate.save).toHaveBeenCalledTimes(1);
   });

   it('still authorizes when the throttle suppresses the write (write is best-effort, not a gate)', async () => {
      // Pre-stamp last_used_at to now so the very first resolution is already inside the window.
      candidate.last_used_at = new Date();
      const result = await resolveAccount(makeReq(TENANT_KEY), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(2);
      expect(candidate.save).not.toHaveBeenCalled();
   });

   it('does write again once the throttle window has elapsed', async () => {
      // Last used well beyond the default 5-minute window: a fresh write is expected.
      candidate.last_used_at = new Date(Date.now() - (10 * 60 * 1000));
      const result = await resolveAccount(makeReq(TENANT_KEY), makeRes());
      expect(result.authorized).toBe(true);
      expect(candidate.save).toHaveBeenCalledTimes(1);
   });

   it('never blocks auth if the throttled save throws', async () => {
      candidate.save.mockImplementation(async () => { throw new Error('write failed'); });
      const result = await resolveAccount(makeReq(TENANT_KEY), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(2);
   });
});
