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

describe('resolveDomainAccess canonicalizes the lookup (cross-tenant-leak fix)', () => {
   // The third-adversarial-review fix: resolveDomainAccess MUST look the Domain up by its CANONICAL
   // form, so a raw variant a caller sends ("getmasset.com.", "WWW.getmasset.com", "GETMASSET.com")
   // resolves the SAME canonical owner row, never a sibling under a different owner. This pins that
   // every non-canonical variant issues the SAME canonical where-clause the gate compares against.
   beforeEach(() => { process.env.MULTI_TENANT = 'true'; });

   it.each([
      ['getmasset.com.', 'getmasset.com'],
      ['WWW.getmasset.com', 'getmasset.com'],
      ['GETMASSET.com', 'getmasset.com'],
      ['https://getmasset.com/path?q=1', 'getmasset.com'],
   ])('a raw variant %s resolves the canonical row %s (read gate)', async (raw, canonical) => {
      const row = { ID: 9, domain: canonical, owner_id: TENANT_A.ID };
      mockDomain.findOne.mockResolvedValue(row);

      const result = await resolveDomainAccess(TENANT_A, raw);

      expect(result).toBe(row);
      // The lookup is keyed on the CANONICAL string, NOT the raw variant, so two canonical-equal
      // strings can never resolve different rows.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: canonical, owner_id: TENANT_A.ID });
   });

   it('a scoped key can never resolve a different-owner sibling: the canonical row is the only match', async () => {
      // owner A owns the canonical "getmasset.com". A request for the raw variant "getmasset.com."
      // canonicalizes to "getmasset.com" and is scoped to owner A, so a row owned by a DIFFERENT
      // account is never reachable: the where-clause carries BOTH the canonical name AND owner A.
      mockDomain.findOne.mockResolvedValue(null);

      const result = await resolveDomainAccess(TENANT_B, 'getmasset.com.');

      expect(result).toBeNull();
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'getmasset.com', owner_id: TENANT_B.ID });
   });

   it('an empty / non-string / unresolvable domain returns null WITHOUT a DB lookup', async () => {
      const r1 = await resolveDomainAccess(TENANT_A, '');
      const r2 = await resolveDomainAccess(TENANT_A, '   ');
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      // canonicalizeDomain('') === '' short-circuits before any Domain.findOne, so a junk param can
      // never become an accidental unscoped lookup.
      expect(mockDomain.findOne).not.toHaveBeenCalled();
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
