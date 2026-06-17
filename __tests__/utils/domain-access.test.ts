/**
 * Unit tests for the per-domain access chokepoint (utils/domain-access.ts).
 *
 * resolveDomainAccess is the single place every per-domain route asks "may this caller
 * touch this domain?". For M1 (before per-domain sharing lands) access is owner-only for
 * BOTH the read gate and the write gate. These tests pin that contract so a regression that
 * weakens the gate (e.g. dropping scopeWhere, or granting non-owners) is caught:
 *
 *   1. With MULTI_TENANT on, an OWNED domain resolves to the Domain row (read AND write).
 *   2. With MULTI_TENANT on, a NOT-owned domain (scopeWhere owner mismatch -> findOne null)
 *      resolves to null for BOTH the read gate and the write gate.
 *   3. The write option (opts.write) still requires ownership today (owner-only), and the
 *      query it issues is owner-scoped exactly like the read gate.
 *   4. With MULTI_TENANT off / admin, the gate is unscoped (no owner_id key), so single-tenant
 *      behavior is a plain Domain.findOne({ domain }).
 *
 * The Domain model is mocked so each call is a pure assertion on the where-clause the helper
 * built; scopeWhere runs for real so the scoped output is the genuine flag-gated value. The
 * helper itself is NOT mocked. No network, no DB.
 */

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

// eslint-disable-next-line import/first
import resolveDomainAccess from '../../utils/domain-access';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import type Account from '../../database/models/account';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };
const account = (id: number): Account => ({ ID: id } as Account);

const ADMIN = account(ADMIN_ACCOUNT_ID);
const TENANT_A = account(2);
const TENANT_B = account(3);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('resolveDomainAccess with MULTI_TENANT on', () => {
   beforeEach(() => { process.env.MULTI_TENANT = 'true'; });

   it('returns the Domain row when the tenant OWNS it (read gate)', async () => {
      const row = { ID: 7, domain: 'a.com', owner_id: TENANT_A.ID };
      mockDomain.findOne.mockResolvedValue(row);

      const result = await resolveDomainAccess(TENANT_A, 'a.com');

      expect(result).toBe(row);
      // The read gate is owner-scoped: the lookup carries the tenant owner_id.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT_A.ID });
   });

   it('returns null when the domain is NOT owned by the caller (read gate)', async () => {
      // owner mismatch: Domain.findOne with { owner_id: B } returns no row for A's domain.
      mockDomain.findOne.mockResolvedValue(null);

      const result = await resolveDomainAccess(TENANT_B, 'a.com');

      expect(result).toBeNull();
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT_B.ID });
   });

   it('returns the Domain row when the tenant OWNS it (write gate)', async () => {
      const row = { ID: 7, domain: 'a.com', owner_id: TENANT_A.ID };
      mockDomain.findOne.mockResolvedValue(row);

      const result = await resolveDomainAccess(TENANT_A, 'a.com', { write: true });

      expect(result).toBe(row);
      // The write gate is owner-only and issues an owner-scoped query, same as the read gate today.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT_A.ID });
   });

   it('write access still requires ownership: a non-owner write gate returns null', async () => {
      mockDomain.findOne.mockResolvedValue(null);

      const result = await resolveDomainAccess(TENANT_B, 'a.com', { write: true });

      expect(result).toBeNull();
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT_B.ID });
   });

   it('admin is unscoped: the gate has no owner_id key (read or write)', async () => {
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });

      await resolveDomainAccess(ADMIN, 'a.com');
      await resolveDomainAccess(ADMIN, 'a.com', { write: true });

      expect(Object.prototype.hasOwnProperty.call(mockDomain.findOne.mock.calls[0][0].where, 'owner_id')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(mockDomain.findOne.mock.calls[1][0].where, 'owner_id')).toBe(false);
   });
});

describe('resolveDomainAccess with MULTI_TENANT off (single-tenant)', () => {
   beforeEach(() => { delete process.env.MULTI_TENANT; });

   it('is a plain by-domain lookup (no owner_id) even for a non-admin account', async () => {
      const row = { ID: 7, domain: 'a.com' };
      mockDomain.findOne.mockResolvedValue(row);

      const result = await resolveDomainAccess(TENANT_A, 'a.com');

      expect(result).toBe(row);
      // Flag off => scopeWhere is {} => the gate is byte-for-byte the legacy Domain.findOne({ domain }).
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com' });
   });

   it('returns null when no domain row exists', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const result = await resolveDomainAccess(null, 'missing.com');
      expect(result).toBeNull();
   });
});
