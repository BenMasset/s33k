/**
 * Unit tests for account-email encryption at rest (utils/accountEmail.ts).
 *
 * Contract:
 *   - encryptEmail stores a value that is NOT the plaintext, and decryptEmail round-trips it back to
 *     the normalized address. So a DB dump exposes ciphertext, not the login email.
 *   - emailHash is DETERMINISTIC (same email -> same hash) and keyed by SECRET (different SECRET ->
 *     different hash), so it backs the UNIQUE lookup index for magic-link login + signup dedupe.
 *   - Normalization (trim + lowercase) means casing/whitespace variants map to the SAME hash, so a
 *     by-hash lookup finds the account regardless of how the email was typed.
 *   - A null/blank email yields a null hash and null ciphertext (many NULLs allowed by the index).
 *
 * No DB, no network. cryptr + crypto run for real (the actual at-rest path).
 */

import {
   encryptEmail, decryptEmail, emailHash, normalizeEmail,
} from '../../utils/accountEmail';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => { process.env = { ...ORIGINAL_ENV }; process.env.SECRET = 'unit-test-secret'; });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('encryptEmail / decryptEmail', () => {
   it('stores ciphertext that is not the plaintext and round-trips back', () => {
      const enc = encryptEmail('Founder@NewCo.com');
      expect(enc).toBeTruthy();
      expect(enc).not.toBe('Founder@NewCo.com');
      expect(enc).not.toBe('founder@newco.com');
      // Decrypts back to the NORMALIZED address.
      expect(decryptEmail(enc)).toBe('founder@newco.com');
   });

   it('returns null for an empty/blank email (null stays null)', () => {
      expect(encryptEmail(null)).toBeNull();
      expect(encryptEmail('')).toBeNull();
      expect(encryptEmail('   ')).toBeNull();
      expect(decryptEmail(null)).toBeNull();
   });

   it('decryptEmail returns null (does not throw) on a non-ciphertext value', () => {
      expect(decryptEmail('not-real-ciphertext')).toBeNull();
   });
});

describe('emailHash (deterministic blind index)', () => {
   it('is deterministic for the same email + SECRET', () => {
      expect(emailHash('user@co.com')).toBe(emailHash('user@co.com'));
   });

   it('is case/whitespace insensitive (normalized before hashing)', () => {
      expect(emailHash('  User@Co.COM ')).toBe(emailHash('user@co.com'));
   });

   it('differs for a different SECRET (keyed HMAC, not a bare hash)', () => {
      const h1 = emailHash('user@co.com');
      process.env.SECRET = 'a-different-secret';
      const h2 = emailHash('user@co.com');
      expect(h1).not.toBe(h2);
   });

   it('returns null for an empty/blank email', () => {
      expect(emailHash(null)).toBeNull();
      expect(emailHash('')).toBeNull();
      expect(emailHash('  ')).toBeNull();
   });

   it('the lookup hash for a stored email matches the hash computed from the typed email', () => {
      // Simulate: account stored with email_hash = emailHash(invite email); login looks up by
      // emailHash(typed email). Same address (any casing) => same hash => the lookup finds it.
      const stored = emailHash('Founder@NewCo.com');
      const lookup = emailHash('founder@newco.com');
      expect(lookup).toBe(stored);
   });
});

describe('normalizeEmail', () => {
   it('trims and lowercases', () => {
      expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
   });
});
