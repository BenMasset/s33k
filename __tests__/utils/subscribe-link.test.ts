/**
 * Unit tests for utils/subscribeLink.ts (the signed one-click checkout token + URL).
 *
 * The token is the credential for the public /api/subscribe link, so the security properties matter:
 * a valid token round-trips to its account id; a token signed with a different secret, a forged
 * token, an expired token, or a wrong-purpose token all verify to null; and nothing works without
 * SECRET. No network.
 */

import jwt from 'jsonwebtoken';
import { mintSubscribeToken, verifySubscribeToken, subscribeUrl } from '../../utils/subscribeLink';

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'unit-test-secret-0123456789abcdef';
const account = (id: number | null) => ({ ID: id } as unknown as Parameters<typeof mintSubscribeToken>[0]);

beforeEach(() => { process.env = { ...ORIGINAL_ENV }; process.env.SECRET = SECRET; });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('utils/subscribeLink', () => {
   it('round-trips: a minted token verifies back to its account id', () => {
      const token = mintSubscribeToken(account(42));
      expect(token).toBeTruthy();
      expect(verifySubscribeToken(token)).toBe(42);
   });

   it('mints null and verifies null when SECRET is unset', () => {
      delete process.env.SECRET;
      expect(mintSubscribeToken(account(42))).toBeNull();
      expect(verifySubscribeToken('anything')).toBeNull();
   });

   it('rejects a token signed with a DIFFERENT secret', () => {
      const foreign = jwt.sign({ accountId: 42, purpose: 'checkout' }, 'some-other-secret');
      expect(verifySubscribeToken(foreign)).toBeNull();
   });

   it('rejects a forged / garbage token', () => {
      expect(verifySubscribeToken('not.a.jwt')).toBeNull();
      expect(verifySubscribeToken('')).toBeNull();
      expect(verifySubscribeToken(undefined)).toBeNull();
   });

   it('rejects a correctly-signed token with the WRONG purpose', () => {
      const wrongPurpose = jwt.sign({ accountId: 42, purpose: 'login' }, SECRET);
      expect(verifySubscribeToken(wrongPurpose)).toBeNull();
   });

   it('rejects a token whose header declares a non-HS256 algorithm (algorithm is pinned)', () => {
      // 'none' is the canonical alg-confusion probe. verify pins algorithms:['HS256'], so even a
      // library that would otherwise honor the header alg must reject this. Fails closed -> null.
      const noneToken = jwt.sign({ accountId: 42, purpose: 'checkout' }, '', { algorithm: 'none' });
      expect(verifySubscribeToken(noneToken)).toBeNull();
   });

   it('rejects an expired token', () => {
      const expired = jwt.sign({ accountId: 42, purpose: 'checkout' }, SECRET, { expiresIn: '-1s' });
      expect(verifySubscribeToken(expired)).toBeNull();
   });

   it('subscribeUrl builds an /api/subscribe?token= URL on the trusted base, or null without SECRET', () => {
      const url = subscribeUrl(account(7), 'https://app.s33k.io/');
      expect(url).toMatch(/^https:\/\/app\.s33k\.io\/api\/subscribe\?token=/);
      // the token in the URL verifies back to the account
      const token = decodeURIComponent((url as string).split('token=')[1]);
      expect(verifySubscribeToken(token)).toBe(7);

      delete process.env.SECRET;
      expect(subscribeUrl(account(7), 'https://app.s33k.io')).toBeNull();
   });
});
