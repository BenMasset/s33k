/**
 * Analytics provider abstraction.
 *
 * s33k joins per-page traffic against tracked keywords to build the scoreboard.
 * The traffic numbers can come from more than one analytics backend, so this
 * module defines a small provider interface and a selector that picks the
 * configured provider from the environment.
 *
 * Providers:
 *   - "umami"  Self-hosted Umami v2 (the standalone, owned analytics engine and
 *              the productization target). See utils/umami.ts.
 *   - "lodd"   Lodd Analytics (a closed third-party SaaS, kept as a legacy/dev
 *              option). See utils/lodd.ts.
 *
 * Selection is driven by the ANALYTICS_PROVIDER env var and defaults to "umami".
 *
 * Contract: getPageTraffic NEVER throws. On a missing-config or network/HTTP
 * problem it resolves to { pages: [], error: <message> } so the scoreboard can
 * degrade gracefully instead of crashing.
 */

/**
 * A page's traffic normalized across providers.
 *
 * Required everywhere:
 *   url         The raw page url or path as reported by the provider.
 *   pathClean   The normalized comparable path (see cleanPath in utils/lodd).
 *   page_views  Pageviews (or the closest count the provider exposes) for the page.
 *
 * Optional, because not every provider reports them:
 *   page_title, unique_visitors, bounce_rate, avg_duration.
 */
export type NormalizedPage = {
   url: string,
   pathClean: string,
   page_views: number,
   page_title?: string,
   unique_visitors?: number,
   bounce_rate?: number,
   avg_duration?: number,
}

export type AnalyticsResult = {
   pages: NormalizedPage[],
   error: string | null,
}

export interface AnalyticsProvider {
   /**
    * Return per-page traffic for a domain.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<AnalyticsResult>} Never rejects; errors come back in `error`.
    */
   getPageTraffic(domain: string, period?: string): Promise<AnalyticsResult>,
}

export type AnalyticsProviderName = 'umami' | 'lodd';

/**
 * Build a provider that always reports "not configured" without throwing.
 * Used when the selected provider is missing its required environment.
 * @param {string} name - The provider name to mention in the error.
 * @returns {AnalyticsProvider}
 */
const unconfiguredProvider = (name: string): AnalyticsProvider => ({
   getPageTraffic: async (): Promise<AnalyticsResult> => ({
      pages: [],
      error: `Analytics provider ${name} is not configured`,
   }),
});

/**
 * Select the active analytics provider from the environment.
 *
 * ANALYTICS_PROVIDER picks the backend ("umami" | "lodd"); it defaults to
 * "umami", the standalone owned-analytics target. If the chosen provider is
 * missing its required env vars, a graceful "not configured" provider is
 * returned instead of throwing, so the scoreboard still responds.
 *
 * @returns {AnalyticsProvider}
 */
export const getAnalyticsProvider = (): AnalyticsProvider => {
   const selected = (process.env.ANALYTICS_PROVIDER || 'umami').trim().toLowerCase() as AnalyticsProviderName;

   if (selected === 'lodd') {
      // Required: LODD_API_KEY + LODD_SITE.
      if (!process.env.LODD_API_KEY || !process.env.LODD_SITE) {
         return unconfiguredProvider('lodd');
      }
      // eslint-disable-next-line global-require
      const { LoddProvider } = require('./lodd');
      return new LoddProvider();
   }

   // Default: Umami. Required: UMAMI_BASE_URL plus either UMAMI_API_KEY or
   // (UMAMI_USERNAME + UMAMI_PASSWORD).
   const hasBase = !!process.env.UMAMI_BASE_URL;
   const hasApiKey = !!process.env.UMAMI_API_KEY;
   const hasLogin = !!process.env.UMAMI_USERNAME && !!process.env.UMAMI_PASSWORD;
   if (!hasBase || (!hasApiKey && !hasLogin)) {
      return unconfiguredProvider('umami');
   }
   // eslint-disable-next-line global-require
   const { UmamiProvider } = require('./umami');
   return new UmamiProvider();
};
