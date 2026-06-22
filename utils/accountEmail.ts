import crypto from 'crypto';
import Cryptr from 'cryptr';

// Encryption + blind-index helpers for account.email at rest.
//
// THE PROBLEM: account.email is the magic-link login KEY and is PII. It was stored plaintext, so a
// DB dump exposed every tenant's login email. It must be encrypted at rest. But it is also LOOKED UP
// (request-link / signup find the account by email) and DEDUPED (a UNIQUE constraint enforces one
// account per email). cryptr (AES-256) uses a random IV per call, so the same email encrypts to a
// DIFFERENT ciphertext every time: you cannot look up or unique-index the ciphertext.
//
// THE FIX (deterministic blind index + encrypted value):
//   - account.email     -> the cryptr-encrypted ciphertext (for storage/display; decryptable to show
//                          the address). Non-deterministic, so NOT used for lookup or uniqueness.
//   - account.email_hash -> a DETERMINISTIC keyed HMAC-SHA256 of the normalized email, hex-encoded.
//                          The same email always yields the same hash, so it backs the UNIQUE index
//                          and is the lookup key. It is keyed by the app SECRET (HMAC, not a bare
//                          SHA-256), so an attacker with a DB dump cannot brute-force the small email
//                          space without also stealing SECRET, and cannot precompute a rainbow table.
//
// Lookups (request-link, signup dedupe) query by email_hash. The plaintext email never hits the DB.
//
// All keyed by process.env.SECRET, the same env var that keys cryptr for connected credentials. With
// MULTI_TENANT off there are no account emails (the single admin has none), so none of this runs on a
// single-tenant install; it is purely additive.

// Normalize an email the SAME way everywhere before hashing/encrypting, so the same address always
// maps to the same hash regardless of incidental casing/whitespace. Mirrors the trim().toLowerCase()
// the auth + invite paths already apply, centralized here so the hash can never drift from the input.
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// The deterministic blind index for an email: keyed HMAC-SHA256(SECRET, normalizedEmail), hex. Stable
// for a given (SECRET, email), so it backs the UNIQUE index and the by-email lookup. Returns null for
// an empty/blank email (no hash for "no email"), so a null email stays a NULL hash (many NULLs are
// permitted by the UNIQUE index, exactly like the prior plaintext column).
export const emailHash = (email: string | null | undefined): string | null => {
   if (!email || !email.trim()) { return null; }
   const secret = process.env.SECRET || '';
   return crypto.createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex');
};

// Encrypt an email for at-rest storage in account.email. Returns null for an empty email so a
// null email stays NULL (unchanged from the prior plaintext column's null handling). cryptr requires
// a non-empty SECRET; if SECRET is unset we cannot encrypt, so we throw (this only runs with
// MULTI_TENANT on, where SECRET is required for the rest of auth anyway).
export const encryptEmail = (email: string | null | undefined): string | null => {
   if (!email || !email.trim()) { return null; }
   const cryptr = new Cryptr(process.env.SECRET as string);
   return cryptr.encrypt(normalizeEmail(email));
};

// Decrypt a stored account.email ciphertext back to the plaintext address (for display). Returns null
// for a null/blank stored value. Best-effort: a value that is not valid ciphertext (e.g. a legacy
// plaintext row not yet migrated, or a SECRET mismatch) returns null rather than throwing, so a
// display path never crashes on a single bad row.
export const decryptEmail = (stored: string | null | undefined): string | null => {
   if (!stored || !stored.trim()) { return null; }
   try {
      const cryptr = new Cryptr(process.env.SECRET as string);
      return cryptr.decrypt(stored);
   } catch (error) {
      return null;
   }
};
