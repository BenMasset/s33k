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
 *
 * bounce_rate / avg_duration may be `null` (not just absent) when a provider can
 * report the page but genuinely cannot compute that metric at page grain. `null`
 * means "known to be unavailable" and is distinct from `undefined` ("not set").
 * When a metric is null, `metricsNote` explains why so the value is not mistaken
 * for zero.
 */
export type NormalizedPage = {
   url: string,
   pathClean: string,
   page_views: number,
   page_title?: string,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   metricsNote?: string,
}

export type AnalyticsResult = {
   pages: NormalizedPage[],
   error: string | null,
}

/**
 * A referral source normalized across providers, for AI-referral tracking.
 *
 * Required everywhere:
 *   name             The referrer host or label as reported by the provider
 *                    (e.g. "chatgpt.com", "ChatGPT", "google.com").
 *   type             The provider's source type if any ("ai", "search",
 *                    "social", "referral", ...) or "unknown" when not provided.
 *   engine           The normalized AI engine label (e.g. "ChatGPT") or null.
 *   isAI             Whether this source is an AI engine.
 *   unique_visitors  Visitor count for the source.
 *
 * Optional, because not every provider reports them:
 *   page_views, utm_source, utm_medium, utm_campaign, landing_path.
 *
 * landing_path is the page a referred visitor first landed on, normalized like
 * NormalizedPage.pathClean. Most providers report referrals only site-wide and
 * leave it undefined; when present it lets the scoreboard attribute AI-referred
 * visitors to a specific page.
 */
export type ReferralSource = {
   name: string,
   type: string,
   engine: string | null,
   isAI: boolean,
   page_views?: number,
   unique_visitors: number,
   utm_source?: string,
   utm_medium?: string,
   utm_campaign?: string,
   landing_path?: string,
}

export type ReferralResult = {
   sources: ReferralSource[],
   error: string | null,
}

/**
 * Site-wide totals for a reporting window, normalized across providers.
 *
 *   pageviews     Total pageviews in the window.
 *   visitors      Unique visitors in the window.
 *   visits        Total visits/sessions (optional; not every provider exposes it).
 *   bounceRate    Bounce rate as a percentage (0..100).
 *   avgDuration   Average visit duration in seconds.
 *   pagesPerVisit Average pages viewed per visit.
 */
export type SummaryResult = {
   pageviews: number,
   visitors: number,
   visits?: number,
   bounceRate: number,
   avgDuration: number,
   pagesPerVisit: number,
   error: string | null,
}

/** A single row of a dimensional breakdown (country, device, browser, ...). */
export type BreakdownRow = {
   name: string,
   page_views?: number,
   unique_visitors: number,
}

export type BreakdownResult = {
   rows: BreakdownRow[],
   error: string | null,
}

/**
 * The dimensions supported by getBreakdown. country/device/browser/os are
 * available from both providers; region/city/language/screen are Umami extras
 * (Lodd has no endpoint and returns a "Not supported by Lodd" error).
 */
export type BreakdownDimension =
   | 'country'
   | 'region'
   | 'city'
   | 'device'
   | 'browser'
   | 'os'
   | 'language'
   | 'screen';

/** One point in a time series: a date label plus that day's pageviews/visitors. */
export type TimeSeriesPoint = {
   date: string,
   pageviews: number,
   visitors: number,
}

export type TimeSeriesResult = {
   series: TimeSeriesPoint[],
   error: string | null,
}

/** A custom/tracked event and how many times it fired in the window. */
export type EventRow = {
   name: string,
   count: number,
}

export type EventsResult = {
   events: EventRow[],
   error: string | null,
}

/**
 * One engagement tier (session-quality bucket) for the window.
 *
 *   label        The tier label (e.g. "bounced", "browsed", "engaged").
 *   sessions     Number of sessions in this tier.
 *   percentage   Share of total sessions in this tier (0..100).
 *   avgDuration  Average session duration in seconds (optional).
 *   avgPages     Average pages per session (optional).
 */
export type EngagementTier = {
   label: string,
   sessions: number,
   percentage: number,
   avgDuration?: number,
   avgPages?: number,
}

export type EngagementResult = {
   tiers: EngagementTier[],
   error: string | null,
}

/**
 * The four first-touch source classes an entry (landing) page's sessions are
 * bucketed into. Mirrors how a marketer thinks about acquisition:
 *   direct    No referrer (typed/bookmarked) or a self-referral.
 *   referral  A non-search, non-AI external site.
 *   search    A traditional search engine (Google, Bing, DuckDuckGo, ...).
 *   ai        An AI answer engine (ChatGPT, Perplexity, Gemini, ...), via the
 *             shared AI classifier (utils/ai-sources.ts).
 */
export type EntryPageSources = {
   direct: number,
   referral: number,
   search: number,
   ai: number,
}

/**
 * One entry (landing) page: where a session STARTS. The acquisition surface.
 *
 *   page      The entry page url/path as reported by the provider.
 *   pathClean The normalized comparable path (see cleanPath in utils/lodd).
 *   entries   How many sessions started on this page in the window.
 *   sources   The first-touch source split for this page (see EntryPageSources).
 *
 * sourcesApproximated is true when the per-page source split was estimated from
 * the site-wide referrer mix rather than measured per page. Umami's aggregate
 * metrics API does not break referrers down per entry page, so this is true for
 * the Umami provider. The accompanying sourcesNote on EntryPagesResult explains
 * it so the split is not read as exact per-page attribution.
 */
export type EntryPage = {
   page: string,
   pathClean: string,
   entries: number,
   sources: EntryPageSources,
   sourcesApproximated: boolean,
}

export type EntryPagesResult = {
   pages: EntryPage[],
   /** Site-wide first-touch source totals for the window (the basis for any approximation). */
   siteSources: EntryPageSources,
   /** Honest note when per-page sources are approximated from the site-wide mix, else null. */
   sourcesNote: string | null,
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

   /**
    * Return referral sources for a domain, classified for AI-referral tracking.
    * Each source is tagged with isAI / engine via the AI classifier
    * (utils/ai-sources.ts). Used by the AI Traffic feature to show which AI
    * engines are sending real visitors.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "90d". Provider-specific.
    * @returns {Promise<ReferralResult>} Never rejects; errors come back in `error`.
    */
   getReferralSources(domain: string, period?: string): Promise<ReferralResult>,

   /**
    * Return site-wide totals for the window: pageviews, visitors, visits,
    * bounce rate, average duration, and pages per visit.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<SummaryResult>} Never rejects; errors come back in `error`.
    */
   getSummary(domain: string, period?: string): Promise<SummaryResult>,

   /**
    * Return a dimensional breakdown (country, region, city, device, browser, os,
    * language, screen). region/city/language/screen are Umami extras; Lodd has no
    * endpoint for them and returns { rows: [], error: 'Not supported by Lodd' }.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {BreakdownDimension} dimension - Which dimension to break down by.
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<BreakdownResult>} Never rejects; errors come back in `error`.
    */
   getBreakdown(domain: string, dimension: BreakdownDimension, period?: string): Promise<BreakdownResult>,

   /**
    * Return a daily (or unit-grouped) time series of pageviews and visitors.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @param {string} [unit] - Bucket unit, e.g. "day". Defaults to "day".
    * @returns {Promise<TimeSeriesResult>} Never rejects; errors come back in `error`.
    */
   getTimeSeries(domain: string, period?: string, unit?: string): Promise<TimeSeriesResult>,

   /**
    * Return custom/tracked events with their fire counts for the window.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<EventsResult>} Never rejects; errors come back in `error`.
    */
   getEvents(domain: string, period?: string): Promise<EventsResult>,

   /**
    * Return engagement tiers (session-quality buckets) for the window.
    * Lodd serves these directly from /session-scores. Umami has no native
    * buckets, so the provider derives tiers from /stats and /sessions.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<EngagementResult>} Never rejects; errors come back in `error`.
    */
   getEngagement(domain: string, period?: string): Promise<EngagementResult>,

   /**
    * Return ENTRY (landing) pages for a domain: where sessions START, the
    * acquisition surface. Each page carries its entry count plus a first-touch
    * source split (direct/referral/search/ai). Most providers cannot break
    * referrers down per entry page, so the per-page source split is approximated
    * from the site-wide mix (every page flagged sourcesApproximated, with
    * sourcesNote on the result explaining it); the per-page entry counts and the
    * site-wide source totals are exact.
    * @param {string} domain - The site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window hint, e.g. "30d". Provider-specific.
    * @returns {Promise<EntryPagesResult>} Never rejects; errors come back in `error`.
    */
   getEntryPages(domain: string, period?: string): Promise<EntryPagesResult>,
}

export type AnalyticsProviderName = 'umami' | 'lodd';

/**
 * Build a provider that always reports "not configured" without throwing.
 * Used when the selected provider is missing its required environment.
 * @param {string} name - The provider name to mention in the error.
 * @returns {AnalyticsProvider}
 */
const unconfiguredProvider = (name: string): AnalyticsProvider => {
   const notConfigured = `Analytics provider ${name} is not configured`;
   return {
      getPageTraffic: async (): Promise<AnalyticsResult> => ({ pages: [], error: notConfigured }),
      getReferralSources: async (): Promise<ReferralResult> => ({ sources: [], error: notConfigured }),
      getSummary: async (): Promise<SummaryResult> => ({
         pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: notConfigured,
      }),
      getBreakdown: async (): Promise<BreakdownResult> => ({ rows: [], error: notConfigured }),
      getTimeSeries: async (): Promise<TimeSeriesResult> => ({ series: [], error: notConfigured }),
      getEvents: async (): Promise<EventsResult> => ({ events: [], error: notConfigured }),
      getEngagement: async (): Promise<EngagementResult> => ({ tiers: [], error: notConfigured }),
      getEntryPages: async (): Promise<EntryPagesResult> => ({
         pages: [], siteSources: { direct: 0, referral: 0, search: 0, ai: 0 }, sourcesNote: null, error: notConfigured,
      }),
   };
};

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
   const umamiModule = require('./umami');
   // Tolerate both the named and (legacy) default export shapes so a bundler interop
   // quirk cannot silently break analytics again (it did once on prod).
   const UmamiProvider = umamiModule.UmamiProvider || umamiModule.default;
   return new UmamiProvider();
};
