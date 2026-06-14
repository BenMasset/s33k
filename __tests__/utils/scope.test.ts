import type Account from '../../database/models/account';
import {
   ADMIN_ACCOUNT_ID,
   isMultiTenantEnabled,
   scopeWhere,
   ownerIdFor,
} from '../../utils/scope';

/**
 * Pure unit tests for the multi-tenant scoping helpers (utils/scope.ts).
 *
 * These helpers encode the "NULL owner_id is the default/admin account" rule that the
 * whole non-breaking multi-tenant design rests on:
 *   - The admin account (ID = ADMIN_ACCOUNT_ID) and a null/undefined account are treated
 *     identically: an UNSCOPED query ({}) and a null owner_id stamp on writes. Legacy
 *     rows stored with NULL owner_id stay fully visible, byte-for-byte like today.
 *   - A real tenant (ID != ADMIN_ACCOUNT_ID) is scoped to { owner_id: ID } on reads and
 *     gets its ID stamped on writes.
 *   - All scoping is gated behind MULTI_TENANT. With the flag off, every caller (even a
 *     "real" tenant ID) is unscoped, so the app behaves exactly like the single-tenant
 *     original.
 *
 * No network, no DB. Account is used only as a typed shape ({ ID }); no instance is
 * connected to a database.
 */

const ORIGINAL_ENV = { ...process.env };

const account = (id: number): Account => ({ ID: id } as Account);

describe('isMultiTenantEnabled', () => {
   afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

   it('is false by default (flag unset)', () => {
      delete process.env.MULTI_TENANT;
      expect(isMultiTenantEnabled()).toBe(false);
   });

   it('is true only when MULTI_TENANT is exactly "true"', () => {
      process.env.MULTI_TENANT = 'true';
      expect(isMultiTenantEnabled()).toBe(true);
   });

   it('is false for any other value', () => {
      process.env.MULTI_TENANT = '1';
      expect(isMultiTenantEnabled()).toBe(false);
      process.env.MULTI_TENANT = 'TRUE';
      expect(isMultiTenantEnabled()).toBe(false);
      process.env.MULTI_TENANT = 'yes';
      expect(isMultiTenantEnabled()).toBe(false);
   });
});

describe('scopeWhere (read scoping)', () => {
   afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

   describe('when MULTI_TENANT is off (default single-tenant)', () => {
      beforeEach(() => { delete process.env.MULTI_TENANT; });

      it('returns an empty (unscoped) where for the admin account', () => {
         expect(scopeWhere(account(ADMIN_ACCOUNT_ID))).toEqual({});
      });

      it('returns an empty (unscoped) where even for a real tenant id', () => {
         // The flag, not the account, gates scoping. Off means everyone is unscoped.
         expect(scopeWhere(account(42))).toEqual({});
      });

      it('returns an empty where for a null or undefined account', () => {
         expect(scopeWhere(null)).toEqual({});
         expect(scopeWhere(undefined)).toEqual({});
      });
   });

   describe('when MULTI_TENANT is on', () => {
      beforeEach(() => { process.env.MULTI_TENANT = 'true'; });

      it('treats the admin account as the unscoped NULL-owner default', () => {
         expect(scopeWhere(account(ADMIN_ACCOUNT_ID))).toEqual({});
      });

      it('treats a null/undefined account as the unscoped NULL-owner default', () => {
         expect(scopeWhere(null)).toEqual({});
         expect(scopeWhere(undefined)).toEqual({});
      });

      it('scopes a real tenant to its own owner_id', () => {
         expect(scopeWhere(account(7))).toEqual({ owner_id: 7 });
         expect(scopeWhere(account(99))).toEqual({ owner_id: 99 });
      });
   });
});

describe('ownerIdFor (write stamping)', () => {
   afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

   describe('when MULTI_TENANT is off (default single-tenant)', () => {
      beforeEach(() => { delete process.env.MULTI_TENANT; });

      it('stamps null for the admin account (matches legacy NULL owner_id)', () => {
         expect(ownerIdFor(account(ADMIN_ACCOUNT_ID))).toBeNull();
      });

      it('stamps null even for a real tenant id while the flag is off', () => {
         expect(ownerIdFor(account(42))).toBeNull();
      });

      it('stamps null for a null or undefined account', () => {
         expect(ownerIdFor(null)).toBeNull();
         expect(ownerIdFor(undefined)).toBeNull();
      });
   });

   describe('when MULTI_TENANT is on', () => {
      beforeEach(() => { process.env.MULTI_TENANT = 'true'; });

      it('stamps null for the admin account (NULL owner_id == admin)', () => {
         expect(ownerIdFor(account(ADMIN_ACCOUNT_ID))).toBeNull();
      });

      it('stamps null for a null/undefined account', () => {
         expect(ownerIdFor(null)).toBeNull();
         expect(ownerIdFor(undefined)).toBeNull();
      });

      it('stamps the tenant id for a real tenant', () => {
         expect(ownerIdFor(account(7))).toBe(7);
         expect(ownerIdFor(account(99))).toBe(99);
      });
   });
});

describe('ADMIN_ACCOUNT_ID', () => {
   it('is the seeded admin row id (1)', () => {
      expect(ADMIN_ACCOUNT_ID).toBe(1);
   });
});
