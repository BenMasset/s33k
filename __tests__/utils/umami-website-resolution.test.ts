/**
 * Tests for per-domain Umami website-id resolution (utils/umami.ts resolveWebsiteId).
 *
 * This is the multi-tenant override that lets each onboarded domain read its OWN Umami
 * website while getmasset.com keeps working unchanged. The resolution order is:
 *   1. preferredId   - the Domain row's umami_website_id (provisioned/stamped on onboard).
 *   2. UMAMI_WEBSITE_ID env - the legacy single-tenant fallback (getmasset.com).
 *   3. GET /api/websites lookup by matching domain - last resort.
 *
 * resolveWebsiteId is exported and pure (apart from the last-resort fetch), so these tests
 * drive it directly with env + a mocked fetch. The Domain model is mocked away (umami.ts
 * imports it for the higher-level loadDomainWebsiteId path) so sequelize-typescript never has
 * to load; resolveWebsiteId itself takes the preferred id as an argument and does not touch
 * the model. No network for the preferred / env cases.
 */

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findOne: jest.fn() },
}));

// eslint-disable-next-line import/first
import { resolveWebsiteId } from '../../utils/umami';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
   process.env = { ...ORIGINAL_ENV };
   // @ts-expect-error cleanup mock
   global.fetch = undefined;
   jest.restoreAllMocks();
});

describe('resolveWebsiteId resolution order', () => {
   it('prefers the per-domain Domain id over the env fallback (no network)', async () => {
      process.env = { ...ORIGINAL_ENV };
      process.env.UMAMI_WEBSITE_ID = 'env-website';
      const fetchMock = jest.fn(async () => { throw new Error('fetch must not run when a preferred id is present'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const { websiteId, error } = await resolveWebsiteId('https://base', 'tok', 'tenant.com', 'domain-website');
      expect(websiteId).toBe('domain-website');
      expect(error).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
   });

   it('falls back to UMAMI_WEBSITE_ID when no preferred id is given (getmasset.com unchanged, no network)', async () => {
      process.env = { ...ORIGINAL_ENV };
      process.env.UMAMI_WEBSITE_ID = 'env-website';
      const fetchMock = jest.fn(async () => { throw new Error('fetch must not run when the env fallback applies'); });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const { websiteId, error } = await resolveWebsiteId('https://base', 'tok', 'getmasset.com');
      expect(websiteId).toBe('env-website');
      expect(error).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
   });

   it('ignores an empty/whitespace preferred id and still uses the env fallback', async () => {
      process.env = { ...ORIGINAL_ENV };
      process.env.UMAMI_WEBSITE_ID = 'env-website';

      const { websiteId } = await resolveWebsiteId('https://base', 'tok', 'getmasset.com', '   ');
      expect(websiteId).toBe('env-website');
   });

   it('looks the website up by domain via GET /api/websites when neither preferred id nor env is set', async () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.UMAMI_WEBSITE_ID;
      const fetchMock = jest.fn(async () => ({
         ok: true,
         status: 200,
         statusText: 'OK',
         json: async () => ({
            data: [
               { id: 'other-id', domain: 'someone-else.com' },
               { id: 'matched-id', domain: 'www.tenant.com' },
            ],
         }),
      }));
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const { websiteId, error } = await resolveWebsiteId('https://base', 'tok', 'tenant.com');
      // The www. prefix on the stored row is normalized away when matching.
      expect(websiteId).toBe('matched-id');
      expect(error).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith('https://base/api/websites', expect.objectContaining({
         headers: { Authorization: 'Bearer tok' },
      }));
   });

   it('returns an error when the lookup finds no matching website', async () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.UMAMI_WEBSITE_ID;
      const fetchMock = jest.fn(async () => ({
         ok: true,
         status: 200,
         statusText: 'OK',
         json: async () => ({ data: [{ id: 'x', domain: 'unrelated.com' }] }),
      }));
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      const { websiteId, error } = await resolveWebsiteId('https://base', 'tok', 'tenant.com');
      expect(websiteId).toBeNull();
      expect(error).toMatch(/no umami website found/i);
   });
});
