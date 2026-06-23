/**
 * Tests for utils/sendTrialEnding.ts.
 *
 * sendTrialEnding(account) is best-effort: it NEVER throws, computes days-left from trial_ends_at,
 * skips when RESEND_API_KEY is unset or the account has no decryptable email, and never logs or
 * returns a secret. It posts a branded email to the Resend HTTP API.
 *
 * No network: global.fetch and utils/accountEmail.decryptEmail are mocked.
 */

jest.mock('../../utils/accountEmail', () => ({ __esModule: true, decryptEmail: jest.fn() }));

// eslint-disable-next-line import/first
import { sendTrialEnding } from '../../utils/sendTrialEnding';
// eslint-disable-next-line import/first
import { decryptEmail } from '../../utils/accountEmail';

const mockDecrypt = decryptEmail as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

// Minimal Account-shaped stub; the function only reads .email and .trial_ends_at.
const acct = (email: string | null, trialEndsAt: Date | string | null) => (
   { ID: 7, email, trial_ends_at: trialEndsAt } as unknown as Parameters<typeof sendTrialEnding>[0]
);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.RESEND_API_KEY = 're_test';
   process.env.NEXT_PUBLIC_APP_URL = 'https://app.s33k.io';
   // SECRET lets the email mint the one-click pre-authenticated /api/subscribe link.
   process.env.SECRET = 'test-secret-for-subscribe-token-0123456789';
   // Default: the account has a decryptable email.
   mockDecrypt.mockReturnValue('user@example.com');
   (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({ ok: true, text: async () => '' }));
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('sendTrialEnding', () => {
   it('sends a Resend email with a days-left subject and the subscribe link', async () => {
      const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      await sendTrialEnding(acct('cipher', endsAt));

      const mockFetch = (global as unknown as { fetch: jest.Mock }).fetch;
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.resend.com/emails');
      const body = JSON.parse((opts as { body: string }).body);
      expect(body.to).toBe('user@example.com');
      // 3 days out rounds to "in 3 days" (the boundary; ceil of just-under-3-days is 3).
      expect(body.subject).toContain('days');
      // The CTA is the one-click pre-authenticated subscribe link (not the old /billing page).
      expect(body.html).toContain('https://app.s33k.io/api/subscribe?token=');
      expect(body.text).toContain('https://app.s33k.io/api/subscribe?token=');
      // The Authorization header carries the key but the value is never returned to a caller; assert
      // the request is shaped right without leaking the key anywhere this test surfaces it.
      expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer re_test');
   });

   it('renders "today" for an already-expired / now trial end', async () => {
      await sendTrialEnding(acct('cipher', new Date(Date.now() - 1000)));
      const mockFetch = (global as unknown as { fetch: jest.Mock }).fetch;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.subject).toContain('today');
   });

   it('renders "in 1 day" for a one-day-out trial', async () => {
      // Just under 24h ceils to 1.
      await sendTrialEnding(acct('cipher', new Date(Date.now() + 23 * 60 * 60 * 1000)));
      const mockFetch = (global as unknown as { fetch: jest.Mock }).fetch;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.subject).toContain('in 1 day');
   });

   it('falls back to "soon" when trial_ends_at is missing/invalid', async () => {
      await sendTrialEnding(acct('cipher', null));
      const mockFetch = (global as unknown as { fetch: jest.Mock }).fetch;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.subject).toContain('soon');
   });

   it('skips the send (no fetch) when RESEND_API_KEY is unset', async () => {
      delete process.env.RESEND_API_KEY;
      await sendTrialEnding(acct('cipher', new Date(Date.now() + 86400000)));
      expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
   });

   it('skips the send when the account has no decryptable email', async () => {
      mockDecrypt.mockReturnValue(null);
      await sendTrialEnding(acct(null, new Date(Date.now() + 86400000)));
      expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
   });

   it('never throws when fetch rejects (best-effort)', async () => {
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => { throw new Error('network down'); });
      await expect(sendTrialEnding(acct('cipher', new Date(Date.now() + 86400000)))).resolves.toBeUndefined();
   });

   it('never throws when Resend returns a non-ok status', async () => {
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({ ok: false, status: 422, text: async () => 'bad' }));
      await expect(sendTrialEnding(acct('cipher', new Date(Date.now() + 86400000)))).resolves.toBeUndefined();
   });
});
