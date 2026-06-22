import Account from '../database/models/account';
import { encryptEmail, emailHash } from './accountEmail';

// provisionAccount is the SHARED account-minting core. It is the ONE place a brand-new TRIALING
// account comes into existence, called by BOTH the invite-accept path (pages/api/invite/accept.ts
// acceptExternal) and the public signup path (pages/api/signup.ts), so the two mint BYTE-IDENTICAL
// accounts. Before this module existed the minting lived inline in invite/accept.ts; extracting it
// here keeps the trial start (subscription_status / trial_ends_at / status / encrypted email) in a
// single source of truth so signup and invite can never drift.
//
// A new account starts a 14-day NO-credit-card trial: subscription_status 'trialing', trial_ends_at
// = now + 14 days, status 'active', plan at its legacy default, NO Stripe customer (no card is
// collected until the user runs Checkout). These fields only matter with MULTI_TENANT on; with the
// flag off the single admin is always treated as active by isAccountActive / resolveCaps. See
// utils/plans.ts for the cap level granted during the trial and the gating once it expires.

// The 14-day no-credit-card trial length. The single source of this constant: invite/accept.ts now
// imports the trial start from here rather than carrying its own copy, so the two cannot diverge.
export const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

// The fields every brand-new account starts with, minus email. Shared by createTrialingAccount so
// the with-email path and the email-collision-retry path produce identical accounts otherwise. A
// caller may pass a fallback (the plaintext email) used only for the display name when no name is
// supplied; it is never stored as the email here (the encrypted email + hash are set separately).
export const newAccountBase = (name: string, fallbackEmail: string | null) => ({
   name: name || fallbackEmail || 'New Account',
   plan: 'free',
   status: 'active',
   subscription_status: 'trialing',
   trial_ends_at: new Date(Date.now() + TRIAL_DURATION_MS),
   stripe_customer_id: null,
});

// createTrialingAccount mints a NEW trialing account stamped with the given email.
//
// The email is ENCRYPTED AT REST: the cryptr ciphertext goes in `email` (decryptable to display the
// address) and the deterministic keyed-HMAC blind index goes in `email_hash` (the lookup + UNIQUE
// dedupe key, since the ciphertext's random IV makes it non-deterministic). See utils/accountEmail.
//
// UNIQUE-collision retry (preserved from the original invite path): account.email_hash carries a
// UNIQUE index. If some account already holds this email, the create throws a unique-constraint
// error. Rather than fail the caller (for signup that would surface as a 500 / inconsistency; for
// invite-accept the invite is already single-use consumed), we retry ONCE WITHOUT any email so the
// user still gets a working account, just without a login-email of its own (the pre-existing account
// that owns the email keeps the magic-link path). Any non-uniqueness error propagates to the caller.
//
// API CONTRACT (other agents depend on this exact shape):
//   export createTrialingAccount(email: string): Promise<Account>
export const createTrialingAccount = async (email: string): Promise<Account> => {
   // Normalize the SAME way accountEmail does internally, so the display-name fallback and the
   // hash/cipher all agree on the canonical form. A blank/invalid email yields a null email account.
   const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
   const encrypted = encryptEmail(cleanEmail);
   const hash = emailHash(cleanEmail);
   try {
      return await Account.create({ ...newAccountBase('', cleanEmail), email: encrypted, email_hash: hash });
   } catch (error) {
      const errName = (error as { name?: string })?.name || '';
      if (cleanEmail && errName === 'SequelizeUniqueConstraintError') {
         // Email already owned by another account: mint the account WITHOUT an email of its own so
         // the caller still succeeds with a working account.
         return Account.create({ ...newAccountBase('', cleanEmail), email: null, email_hash: null });
      }
      throw error;
   }
};

export default createTrialingAccount;
