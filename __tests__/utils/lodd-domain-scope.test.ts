import { LoddProvider } from '../../utils/lodd';

/**
 * Tests for the Lodd single-site domain-scoping guard.
 *
 * Lodd is keyed by a single LODD_SITE UUID, not by domain. The provider must be
 * honest: when asked about a domain that is not the configured site's domain, it
 * returns an empty, non-crashing result with a clear explanatory error rather
 * than silently serving the one configured site's data under the wrong label.
 *
 * fetch is mocked so these tests are pure (no network). resetModules between
 * tests clears the module-level resolved-domain cache in utils/lodd.ts.
 */

const ORIGINAL_ENV = { ...process.env };

const sitesResponse = (id: string, domain: string) => ({
   ok: true,
   status: 200,
   statusText: 'OK',
   json: async () => ({ data: [{ id, name: 'Test Site', domain }] }),
   text: async () => '',
});

const pagesResponse = (rows: any[]) => ({
   ok: true,
   status: 200,
   statusText: 'OK',
   json: async () => ({ data: rows }),
   text: async () => '',
});

describe('LoddProvider domain scoping', () => {
   beforeEach(() => {
      jest.resetModules();
      process.env = { ...ORIGINAL_ENV };
      process.env.LODD_API_KEY = 'test-key';
      process.env.LODD_SITE = 'site-uuid-1';
      process.env.LODD_BASE_URL = 'https://api.lodd.dev/v1';
      delete process.env.LODD_SITE_DOMAIN;
   });

   afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
      // @ts-expect-error cleanup mock
      global.fetch = undefined;
      jest.resetModules();
   });

   it('returns an explanatory empty result when the domain does not match the site (via /sites lookup)', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url.endsWith('/sites')) { return sitesResponse('site-uuid-1', 'getmasset.com') as any; }
         throw new Error('data endpoint should NOT be called on a mismatch');
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // Re-require so the module picks up the mocked fetch and a fresh cache.
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { LoddProvider: FreshProvider } = require('../../utils/lodd');
      const provider = new FreshProvider();
      const result = await provider.getPageTraffic('competitor.com', '30d');

      expect(result.pages).toEqual([]);
      expect(result.error).toMatch(/single site/i);
      expect(result.error).toContain('getmasset.com');
      expect(result.error).toContain('competitor.com');
      // The data (pages) endpoint must never be hit on a mismatch.
      const calledData = fetchMock.mock.calls.some(([u]) => String(u).includes('/pages'));
      expect(calledData).toBe(false);
   });

   it('passes through to the data endpoint when the domain matches the site', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url.endsWith('/sites')) { return sitesResponse('site-uuid-1', 'getmasset.com') as any; }
         if (url.includes('/pages')) {
            return pagesResponse([{ url: 'https://getmasset.com/software/mcp', page_views: 42, unique_visitors: 30 }]) as any;
         }
         throw new Error(`unexpected url ${url}`);
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { LoddProvider: FreshProvider } = require('../../utils/lodd');
      const provider = new FreshProvider();
      const result = await provider.getPageTraffic('getmasset.com', '30d');

      expect(result.error).toBeNull();
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].page_views).toBe(42);
      expect(result.pages[0].pathClean).toBe('/software/mcp');
   });

   it('treats www. and casing differences as a match', async () => {
      const fetchMock = jest.fn(async (url: string) => {
         if (url.endsWith('/sites')) { return sitesResponse('site-uuid-1', 'getmasset.com') as any; }
         if (url.includes('/pages')) { return pagesResponse([]) as any; }
         throw new Error(`unexpected url ${url}`);
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { LoddProvider: FreshProvider } = require('../../utils/lodd');
      const provider = new FreshProvider();
      const result = await provider.getPageTraffic('WWW.GetMasset.com', '30d');

      expect(result.error).toBeNull();
      expect(result.pages).toEqual([]);
   });

   it('uses LODD_SITE_DOMAIN env override without calling /sites', async () => {
      process.env.LODD_SITE_DOMAIN = 'example.com';
      const fetchMock = jest.fn(async (url: string) => {
         if (url.endsWith('/sites')) { throw new Error('/sites should NOT be called when LODD_SITE_DOMAIN is set'); }
         throw new Error('data endpoint should NOT be called on a mismatch');
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { LoddProvider: FreshProvider } = require('../../utils/lodd');
      const provider = new FreshProvider();
      const result = await provider.getSummary('other.com', '30d');

      expect(result.error).toMatch(/single site/i);
      expect(result.error).toContain('example.com');
      expect(result.pageviews).toBe(0);
   });

   it('fails open (serves the one site) when the site domain cannot be determined', async () => {
      // /sites returns a list that does not contain the configured site id, so
      // the site domain is undeterminable. The provider should not block.
      const fetchMock = jest.fn(async (url: string) => {
         if (url.endsWith('/sites')) { return sitesResponse('some-other-site', 'unrelated.com') as any; }
         if (url.includes('/pages')) { return pagesResponse([{ url: '/x', page_views: 1 }]) as any; }
         throw new Error(`unexpected url ${url}`);
      });
      // @ts-expect-error assign mock
      global.fetch = fetchMock;

      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { LoddProvider: FreshProvider } = require('../../utils/lodd');
      const provider = new FreshProvider();
      const result = await provider.getPageTraffic('anything.com', '30d');

      // Fail-open: data still served (the only configured site), no block error.
      expect(result.pages).toHaveLength(1);
   });


   it('exports a LoddProvider class', () => {
      expect(typeof LoddProvider).toBe('function');
   });
});
