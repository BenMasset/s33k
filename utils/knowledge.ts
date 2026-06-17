/**
 * The single source of truth for s33k product knowledge.
 *
 * This module is what makes s33k self-supporting: a user can ask their own LLM ANY
 * question about s33k (what a capability does, how to set up tracking, why a design
 * decision was made, how to troubleshoot, whether it is safe) and the answer comes from
 * here, exposed three ways over MCP:
 *   1. the `help` tool (GET /api/help), an "ask s33k anything" lookup;
 *   2. MCP resources (resources/list + resources/read), listable/readable docs a client
 *      can pull into context;
 *   3. self-explaining tool descriptions (each capability below carries the same facts the
 *      tool description states).
 *
 * Single-source discipline: this module does NOT restate the install guides or the security
 * facts. It REFERENCES them. The setup section points the reader at getInstallGuides()
 * (utils/install-guides.ts) and the trust section embeds the live securityFacts object
 * (utils/securityFacts.ts) by import, so there is exactly one place each fact lives. The
 * capability catalog below is the one new body of knowledge, and the coverage test
 * (durability guarantee) asserts every registered MCP tool has an entry here, so the
 * answers can never silently rot.
 *
 * It is intentionally dependency-light (only the two existing knowledge sources) so the
 * GET /api/help route stays lightweight and the catalog can be imported anywhere.
 */

import { securityFacts, SecurityFacts } from './securityFacts';

/** One MCP tool / capability, described so an LLM can answer "what is this and when do I use it?" */
export type CapabilityEntry = {
   /** Stable id; equals the registered MCP tool name. */
   id: string,
   /** The registered MCP tool name (same as id; kept explicit for the coverage test). */
   toolName: string,
   /** Which s33k pillar this belongs to. */
   category: 'seo' | 'aeo' | 'analytics' | 'cross-pillar' | 'onboarding' | 'account' | 'security',
   /** Short human title. */
   title: string,
   /** What the capability does, in one or two plain sentences. */
   description: string,
   /** When an LLM should reach for it. */
   whenToUse: string,
   /** A natural-language prompt a user could say that should trigger this capability. */
   examplePrompt: string,
};

/** A reasoning entry: an honest "why we built it this way" answer. */
export type ReasoningEntry = {
   id: string,
   question: string,
   answer: string,
};

/** A troubleshooting entry: a common problem and how to resolve it. */
export type TroubleshootingEntry = {
   id: string,
   problem: string,
   resolution: string,
};

export type KnowledgeBase = {
   /** Every MCP tool, one entry each. The coverage test enforces completeness. */
   capabilities: CapabilityEntry[],
   /** How to install s33k and add tracking. References the install-guide library, never duplicates it. */
   setup: {
      summary: string,
      fiveMinutesToValue: string,
      addTrackingCode: string,
      connectSearchConsole: string,
      installGuidesSource: string,
   },
   /** Honest design reasoning, pulled from BUILD_PLAN.md and SECURITY.md. */
   reasoning: ReasoningEntry[],
   /** Common issues and their fixes. */
   troubleshooting: TroubleshootingEntry[],
   /** Trust + security. References the single securityFacts source, never duplicates it. */
   trust: { summary: string, facts: SecurityFacts },
   /** Pricing, limits, and privacy at a high level. */
   pricingAndLimits: {
      model: string,
      keywordTracking: string,
      externalInvites: string,
      memberSeats: string,
      privacy: string,
   },
};

// ---------------------------------------------------------------------------
// Capabilities: one entry per registered MCP tool (40 total).
// Keep these in lockstep with mcp/src/index.ts; the coverage test fails the build
// if any registered tool lacks an entry here.
// ---------------------------------------------------------------------------
const capabilities: CapabilityEntry[] = [
   // --- Self-support ---
   {
      id: 'help',
      toolName: 'help',
      category: 'cross-pillar',
      title: 'Ask s33k anything',
      description: 'Answers any question about s33k from its single product-knowledge layer: what a capability does, how to set up tracking, why a '
         + 'design decision was made, how to troubleshoot, whether it is safe, and pricing/limits. Reads no account data and never queries an LLM.',
      whenToUse: 'Use whenever you are unsure how s33k works, and as the first thing to call to confirm whether a capability exists before telling '
         + 'the user it does not.',
      examplePrompt: 'How do I add the s33k tracking code, and is s33k safe?',
   },
   {
      id: 'request_feature',
      toolName: 'request_feature',
      category: 'account',
      title: 'Request a feature s33k does not have',
      description: 'Submits a request for a NEW s33k capability for the team to review. You must first confirm via help that the capability does NOT '
         + 'already exist; the server also cross-checks and refuses to store a request that matches an existing capability, telling you which one to '
         + 'use instead.',
      whenToUse: 'Use ONLY after help has shown the need is genuinely unmet. Never offer or call it for something s33k already does.',
      examplePrompt: 'Can s33k export my keyword rank history as a CSV?',
   },
   {
      id: 'list_feature_requests',
      toolName: 'list_feature_requests',
      category: 'account',
      title: 'List submitted feature requests (admin only)',
      description: 'Lists the feature requests users have submitted, optionally filtered by status (open, reviewed, planned, declined, shipped). '
         + 'Restricted to the root admin account.',
      whenToUse: 'Use to review what users are asking for. Admin only; a non-admin or read-only member key is rejected.',
      examplePrompt: 'What feature requests have come in?',
   },
   // --- SEO (rank tracking + Search Console) ---
   {
      id: 'list_domains',
      toolName: 'list_domains',
      category: 'seo',
      title: 'List domains',
      description: 'Lists every domain tracked in s33k with its name and settings.',
      whenToUse: 'Call this first to discover which domains exist before any domain-scoped tool.',
      examplePrompt: 'What domains am I tracking in s33k?',
   },
   {
      id: 'create_domain',
      toolName: 'create_domain',
      category: 'seo',
      title: 'Create domain',
      description: 'Adds one or more domains to track. Takes bare hostnames, not full URLs.',
      whenToUse: 'Use once per site before adding its keywords or reading its analytics.',
      examplePrompt: 'Start tracking example.com in s33k.',
   },
   {
      id: 'list_keywords',
      toolName: 'list_keywords',
      category: 'seo',
      title: 'List keywords',
      description: 'Lists a domain\'s tracked keywords with current Google rank, ranking URL, target page, and recent rank history.',
      whenToUse: 'Use to read SEO standings, get keyword IDs for update/delete, or check whether a keyword has scraped yet.',
      examplePrompt: 'Show me the keyword rankings for getmasset.com.',
   },
   {
      id: 'add_keyword',
      toolName: 'add_keyword',
      category: 'seo',
      title: 'Add keyword',
      description: 'Adds one keyword to track for a domain and queues a background Google SERP scrape so its rank appears shortly.',
      whenToUse: 'Use to start tracking a term; pass target_page so it joins to a page in the scoreboard. Call once per keyword to add several.',
      examplePrompt: 'Track the keyword "AI-ready DAM" for getmasset.com, target page /software.',
   },
   {
      id: 'update_keyword',
      toolName: 'update_keyword',
      category: 'seo',
      title: 'Update keyword',
      description: 'Updates tracked keywords by ID: set the target_page that should rank for them, or toggle the sticky pin.',
      whenToUse: 'Use to fix a keyword\'s target page so it joins correctly in page_scoreboard. Get IDs from list_keywords first.',
      examplePrompt: 'Set the target page for keyword 42 to /software/mcp.',
   },
   {
      id: 'delete_keyword',
      toolName: 'delete_keyword',
      category: 'seo',
      title: 'Delete keyword',
      description: 'Permanently deletes tracked keywords by ID. Cannot be undone.',
      whenToUse: 'Use to stop tracking terms you no longer care about. Confirm the IDs first.',
      examplePrompt: 'Stop tracking keywords 12 and 13.',
   },
   {
      id: 'refresh_keywords',
      toolName: 'refresh_keywords',
      category: 'seo',
      title: 'Refresh keywords',
      description: 'Re-scrapes live Google rankings for stale keywords, by a list of IDs or by an entire domain.',
      whenToUse: 'Use when rankings may be out of date. A small batch returns synchronously; a larger one runs in the background.',
      examplePrompt: 'Refresh all rankings for getmasset.com.',
   },
   {
      id: 'get_insight',
      toolName: 'get_insight',
      category: 'seo',
      title: 'Get Search Console insight',
      description: 'Reads Google Search Console insight for a domain: top pages, top keywords, top countries, and aggregate stats.',
      whenToUse: 'Use for real impression and click data from Google, beyond the keywords you explicitly track. Requires Search Console connected.',
      examplePrompt: 'What are my top Search Console pages for getmasset.com?',
   },
   // --- AEO (AI answer-engine visibility) ---
   {
      id: 'ai_referrals',
      toolName: 'ai_referrals',
      category: 'aeo',
      title: 'AI referrals',
      description: 'Reports which AI engines (ChatGPT, Perplexity, Gemini, Claude, Copilot) sent real visitors to a domain, from analytics referral '
         + 'data.',
      whenToUse: 'Use to measure AEO outcomes: actual traffic AI answer engines drove. It reads referral data and never queries an LLM.',
      examplePrompt: 'Which AI engines are sending traffic to getmasset.com?',
   },
   {
      id: 'ai_crawlers',
      toolName: 'ai_crawlers',
      category: 'aeo',
      title: 'AI crawlers',
      description: 'Reports which AI and search crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot) are crawling a domain.',
      whenToUse: 'Use as the leading indicator of AEO: AI bots crawl a site before any AI engine cites it, so this shows up before ai_referrals '
         + 'does.',
      examplePrompt: 'Are AI bots crawling getmasset.com?',
   },
   {
      id: 'ai_visibility',
      toolName: 'ai_visibility',
      category: 'aeo',
      title: 'AI visibility funnel',
      description: 'Joins AI crawls (the leading indicator) and AI referrals (the outcome) into one funnel per engine and per page, using only '
         + 'first-party un-gameable behavior. Never queries an LLM.',
      whenToUse: 'Use to answer "how visible am I in AI search, and where is the gap?" Read crawled-not-cited pages and aware-not-recommending '
         + 'engines as the work to do.',
      examplePrompt: 'How visible is getmasset.com in AI search, and where are the gaps?',
   },
   // --- Analytics (traffic + autocapture engagement) ---
   {
      id: 'traffic_summary',
      toolName: 'traffic_summary',
      category: 'analytics',
      title: 'Traffic summary',
      description: 'Site-wide traffic totals for a domain: pageviews, visitors, visits, bounce rate, average duration, and pages per visit.',
      whenToUse: 'Use for the one-line health check before drilling into breakdown, timeseries, or the scoreboard.',
      examplePrompt: 'Give me the traffic summary for getmasset.com over the last 30 days.',
   },
   {
      id: 'traffic_breakdown',
      toolName: 'traffic_breakdown',
      category: 'analytics',
      title: 'Traffic breakdown',
      description: 'Breaks a domain\'s traffic down by one dimension: country, region, city, device, browser, os, language, or screen.',
      whenToUse: 'Use to answer where visitors come from or what they use. Region/city/language/screen are Umami-only extras.',
      examplePrompt: 'Break down getmasset.com traffic by country.',
   },
   {
      id: 'traffic_timeseries',
      toolName: 'traffic_timeseries',
      category: 'analytics',
      title: 'Traffic time series',
      description: 'A daily (or unit-grouped) time series of pageviews and visitors for a domain over a window.',
      whenToUse: 'Use to spot trends, spikes, and drops over time, or to compare two periods.',
      examplePrompt: 'Show getmasset.com daily pageviews over the last 30 days.',
   },
   {
      id: 'top_events',
      toolName: 'top_events',
      category: 'analytics',
      title: 'Top events',
      description: 'Lists a domain\'s custom or tracked events with their fire counts.',
      whenToUse: 'Use to see which tracked actions (signups, clicks, downloads) fired most. Empty when the site records no custom events.',
      examplePrompt: 'What are the top tracked events on getmasset.com?',
   },
   {
      id: 'engagement',
      toolName: 'engagement',
      category: 'analytics',
      title: 'Engagement tiers',
      description: 'Breaks a domain\'s sessions into engagement tiers (bounced, browsed, engaged) over a window.',
      whenToUse: 'Use to judge traffic quality, not just volume: a high bounced share signals low-quality or bot traffic.',
      examplePrompt: 'How engaged is the traffic on getmasset.com?',
   },
   {
      id: 'human_traffic',
      toolName: 'human_traffic',
      category: 'analytics',
      title: 'Human vs bot traffic estimate',
      description: 'Estimates how much of a domain\'s traffic is likely humans versus likely bots, using a behavior heuristic with a known-human '
         + 'referrer floor.',
      whenToUse: 'Use to sanity-check the other traffic numbers, because most analytics overcount JavaScript-executing scrapers. It is an estimate, '
         + 'not an exact count.',
      examplePrompt: 'How much of getmasset.com traffic is real humans versus bots?',
   },
   {
      id: 'human_analytics',
      toolName: 'human_analytics',
      category: 'analytics',
      title: 'Human-only analytics (bots excluded), with exit and bounce rate',
      description: 'Human-only traffic analytics computed from s33k\'s own first-party pageview events, with datacenter/bot traffic excluded by '
         + 'default. Each pageview\'s source IP is classified as datacenter-or-not at ingest (is_bot), so JavaScript-executing cloud scrapers are '
         + 'filtered instead of counted. Returns visitors, pageviews, pagesPerSession, bounceRatePct, entryPages, and exitPages with exitRatePct, '
         + 'plus botVisitorsFiltered and botSharePct.',
      whenToUse: 'Use when you want real human numbers, including the exit rate the Umami-backed traffic view cannot produce. Unlike human_traffic '
         + '(a behavioral ESTIMATE over Umami data), this is computed from first-party IP-classified pageviews and is exact for the pageviews it '
         + 'has. Requires the s33k.js tracking script installed so pageviews flow in. Pass includeBots=true for the raw with-bots view.',
      examplePrompt: 'Show me getmasset.com analytics for humans only, with bounce and exit rate.',
   },
   {
      id: 'top_clicks',
      toolName: 'top_clicks',
      category: 'analytics',
      title: 'Top clicks',
      description: 'Lists the most-clicked elements on a domain from s33k autocapture (zero per-element setup). Reports the element text and '
         + 'selector, never any typed value.',
      whenToUse: 'Use to see which CTAs, nav links, and buttons actually get clicked. Cookieless, no PII.',
      examplePrompt: 'Which buttons get clicked most on getmasset.com?',
   },
   {
      id: 'form_submissions',
      toolName: 'form_submissions',
      category: 'analytics',
      title: 'Form submissions',
      description: 'Reports form-submission activity from s33k autocapture: which forms get submitted, how often, and from which pages. Records the '
         + 'form id/name only, never field values.',
      whenToUse: 'Use to measure conversion or funnel health, signup volume, and contact-form engagement. Cookieless, no PII.',
      examplePrompt: 'How many form submissions did getmasset.com get this month?',
   },
   {
      id: 'scroll_depth',
      toolName: 'scroll_depth',
      category: 'analytics',
      title: 'Scroll depth',
      description: 'Reports how far visitors scroll on a domain\'s pages from s33k autocapture, with a site-wide distribution histogram.',
      whenToUse: 'Use to find which pages get read deeply versus abandoned at the top. Cookieless, no PII.',
      examplePrompt: 'Which pages on getmasset.com do people actually scroll through?',
   },
   {
      id: 'page_engagement',
      toolName: 'page_engagement',
      category: 'analytics',
      title: 'Page engagement time',
      description: 'Reports active engagement (dwell) time per page from s33k autocapture, pausing the timer when the tab is hidden or the visitor '
         + 'goes idle.',
      whenToUse: 'Use to see which pages truly hold attention versus which bounce, beyond raw pageviews. Cookieless, no PII.',
      examplePrompt: 'Which pages hold attention longest on getmasset.com?',
   },
   {
      id: 'conversions_by_source',
      toolName: 'conversions_by_source',
      category: 'analytics',
      title: 'Conversions by source',
      description: 'Attributes conversions (autocaptured form submissions by default, or any chosen event type) to the first-touch source the '
         + 'visitor arrived from (direct, organic-search, ai, or a referral host), with per-source counts, share of total, the top converting '
         + 'source, and an honestly-approximate conversion rate. Answers which traffic sources actually convert with no GA4 setup. Cookieless, '
         + 'no PII; the source is a classification or bare host, never a full referrer URL.',
      whenToUse: 'Use to find which channels drive real business outcomes (form fills, signups) and not just traffic volume, and to decide where '
         + 'to invest. Where form_submissions counts conversions by form/page, this splits them by acquisition source.',
      examplePrompt: 'Which traffic sources drive the most conversions on getmasset.com?',
   },
   // --- Cross-pillar analyst ---
   {
      id: 'page_scoreboard',
      toolName: 'page_scoreboard',
      category: 'cross-pillar',
      title: 'Page scoreboard',
      description: 'Joins per-page traffic with tracked keywords for a domain: which pages earn traffic, what each ranks for, and where the content '
         + 'gaps are.',
      whenToUse: 'Use for the core SEO-plus-analytics view, and to find pages with traffic but no tracked keyword (a content-gap signal).',
      examplePrompt: 'Show the per-page scoreboard for getmasset.com.',
   },
   {
      id: 'entry_pages',
      toolName: 'entry_pages',
      category: 'cross-pillar',
      title: 'Entry page analysis',
      description: 'Analyzes a domain\'s ENTRY (landing) pages, where sessions start and acquisition happens. For each entry page it joins the '
         + 'first-touch source split (direct/referral/search/ai), the page\'s tracked keywords and current Google rank, and its AI referrals, '
         + 'then assigns a status: working (ranks AND lands from search), ranking-not-landing (tracks ranking keywords but gets little entry '
         + 'traffic, a gap to fix), brand-direct (lots of direct/referral entries but no tracked ranking), ai-landing (AI search is a meaningful '
         + 'first-touch source), or opportunity (entry traffic but neither ranking nor AI). Per-page source splits are approximated from the '
         + 'site-wide referrer mix and the response says so.',
      whenToUse: 'Use to see which pages are the real acquisition surface, connect "we rank for X" to "X actually lands people", find pages '
         + 'that rank but drive no entry traffic, and decide where to invest. Complements page_scoreboard (all pages) by focusing only on '
         + 'entry pages.',
      examplePrompt: 'Which entry pages on getmasset.com rank AND land, and which rank but drive no traffic?',
   },
   {
      id: 'insights',
      toolName: 'insights',
      category: 'cross-pillar',
      title: 'Cross-pillar insights',
      description: 'A ready-made rules-based analysis joining SEO rank, traffic, AI referrals, and engagement into structured findings and '
         + 'recommendations. The server does the joins; it never calls an LLM.',
      whenToUse: 'Use when you want the highest-leverage findings without running each tool yourself.',
      examplePrompt: 'What are the biggest SEO and analytics opportunities for getmasset.com?',
   },
   {
      id: 'briefing',
      toolName: 'briefing',
      category: 'cross-pillar',
      title: 'Daily briefing',
      description: 'A single proactive cross-pillar daily standup for a domain: a headline, sections, and the top 3 recommended actions in priority '
         + 'order. Rules-based, never calls an LLM.',
      whenToUse: 'Use as the FIRST call each day or whenever the user asks "how is my site doing?" or "what should I work on?"',
      examplePrompt: 'Give me the daily briefing for getmasset.com.',
   },
   {
      id: 'alerts',
      toolName: 'alerts',
      category: 'cross-pillar',
      title: 'Proactive alerts: what changed and what to do',
      description: 'Your "what changed and what to do" standup across SEO, AI search, and analytics. Compares the current period to the prior '
         + 'one and surfaces notable shifts as a prioritized list of plain-English alerts: keyword rank moves of 5+ positions or crossing page one, '
         + 'traffic swings of 25%+, any NEW AI referral engine or AI crawler (a leading AEO signal), and form-submission/conversion shifts of 30%+. '
         + 'Each alert carries a severity, the headline shift, a detail, and a concrete recommendation; the response also returns the single most '
         + 'important thing to act on right now. Rules-based: it never calls an LLM, and it stays silent on a signal it cannot honestly measure '
         + 'rather than inventing a movement.',
      whenToUse: 'Use as your period-over-period standup to see what moved since the prior window and get a concrete next action. Where briefing '
         + 'answers "how is my site right now?", this answers "what moved and what should I do about it?"',
      examplePrompt: 'What moved on my site since the prior period, and what should I do about it?',
   },
   // --- Onboarding ---
   {
      id: 'discover_pages',
      toolName: 'discover_pages',
      category: 'onboarding',
      title: 'Discover pages',
      description: 'Crawls a domain (sitemap first, then homepage links) and returns a compact summary of each important page: url, title, meta, '
         + 'headings, excerpt. No server-side LLM.',
      whenToUse: 'Use at the start so you can map keywords to real pages instead of guessing. Capped at 25 pages.',
      examplePrompt: 'Crawl getmasset.com and list its main pages.',
   },
   {
      id: 'onboard',
      toolName: 'onboard',
      category: 'onboarding',
      title: 'Onboard a domain',
      description: 'One call from nothing to live data: creates the domain, discovers keywords, adds up to 20 and queues rank scrapes, provisions an '
         + 'analytics website, and returns the tracking snippet plus install guides.',
      whenToUse: 'Use as the first thing you do for a brand new site. The only input is the bare domain.',
      examplePrompt: 'Set up everything in s33k for example.com.',
   },
   {
      id: 'install_instructions',
      toolName: 'install_instructions',
      category: 'onboarding',
      title: 'Install instructions',
      description: 'Returns the tracking snippet plus step-by-step install guides for the user\'s platform (WordPress, Webflow, Shopify, '
         + 'Squarespace, Wix, GTM, Next.js/React, raw HTML) for an already-onboarded domain.',
      whenToUse: 'Use when someone asks "how do I add the tracking code on <platform>" or needs the snippet again after onboarding.',
      examplePrompt: 'How do I add the s33k tracking code on Webflow?',
   },
   // --- Account / invites / waitlist ---
   {
      id: 'invite_external',
      toolName: 'invite_external',
      category: 'account',
      title: 'Invite an external user',
      description: 'Sends an external invite that brings a brand-new admin and their own account into s33k. Limited per account by a quota (default '
         + '5). Requires an admin API key.',
      whenToUse: 'Use to invite someone OUTSIDE your organization to start using s33k for their own domain.',
      examplePrompt: 'Invite jane@company.com to s33k.',
   },
   {
      id: 'invite_internal',
      toolName: 'invite_internal',
      category: 'account',
      title: 'Invite an internal teammate',
      description: 'Sends an internal invite that adds a read-only member seat to YOUR OWN account. Unlimited. Requires an admin API key.',
      whenToUse: 'Use to bring a colleague onto your existing account who should see your data but not change anything.',
      examplePrompt: 'Add my teammate team@company.com as a read-only viewer.',
   },
   {
      id: 'list_invites',
      toolName: 'list_invites',
      category: 'account',
      title: 'List invites you have sent',
      description: 'Lists every invite your account has created, both external and internal, with status and quota usage. Requires an admin API key.',
      whenToUse: 'Use to see who you have invited, which invites are pending or accepted, and how many external invites you have used.',
      examplePrompt: 'Show me the invites I have sent.',
   },
   {
      id: 'list_waitlist',
      toolName: 'list_waitlist',
      category: 'account',
      title: 'List waitlist signups',
      description: 'Lists everyone who signed up for the s33k waitlist. Restricted to the root admin account.',
      whenToUse: 'Use to review pending demand before deciding who to send external invites to.',
      examplePrompt: 'Who is on the s33k waitlist?',
   },
   // --- Security / data ownership ---
   {
      id: 'export_data',
      toolName: 'export_data',
      category: 'security',
      title: 'Export all your account data',
      description: 'Downloads everything s33k holds about your account as one tenant-scoped JSON bundle: domains, keywords with rank history, '
         + 'crawler hits, autocapture events, and account metadata. Never includes a secret.',
      whenToUse: 'Use whenever you want to take your data with you, back it up, or verify exactly what s33k stores.',
      examplePrompt: 'Export all of my s33k data.',
   },
   {
      id: 'delete_account_data',
      toolName: 'delete_account_data',
      category: 'security',
      title: 'Permanently delete all your account data',
      description: 'Permanently and irreversibly deletes your entire account and all of its data. Requires the exact confirmation string "DELETE". '
         + 'Tenant-scoped; can never delete the root admin account.',
      whenToUse: 'Use ONLY when the user has clearly asked to erase their account. Confirm first, because there is no undo.',
      examplePrompt: 'Delete my s33k account and all its data.',
   },
   {
      id: 'security_facts',
      toolName: 'security_facts',
      category: 'security',
      title: 'Is s33k safe? Get the trust facts',
      description: 'Returns s33k\'s complete, source-cited trust facts: no model training, tenant isolation, encryption at rest, data ownership, '
         + 'open-source/self-hostable, and cookieless/no-PII tracking.',
      whenToUse: 'Use whenever a user asks whether s33k is safe, private, or trustworthy, or whether it trains on or shares their data.',
      examplePrompt: 'Is s33k safe? Do you train on my data?',
   },
];

// ---------------------------------------------------------------------------
// Setup (references the install-guide library; does not duplicate its content).
// ---------------------------------------------------------------------------
const setup = {
   summary: 'Install s33k from source (clone, npm install, set the .env, npm run build, npm start) or run the bundled '
      + 'docker-compose stack (s33k + Umami + Postgres). Then connect your LLM by adding the MCP server with your s33k '
      + 'API key as S33K_API_KEY and your instance URL as S33K_BASE_URL. Full steps live in README.md, DEPLOY.md, and '
      + 'mcp/README.md in the repository.',
   fiveMinutesToValue: 'The bar is install-to-real-data in about five minutes. The fastest path is the onboard capability: '
      + 'give s33k one bare domain and it creates the domain, discovers keywords, queues live Google rank scrapes, '
      + 'provisions an analytics website, and hands back the tracking snippet. Rankings appear shortly after onboarding '
      + '(rankingsPending comes back true while the background scrape runs).',
   addTrackingCode: 'Analytics, autocapture engagement, and AI-crawler signal only flow once the tracking script is on the '
      + 'site. After onboarding, call install_instructions for your platform to get the exact snippet and copy-paste steps '
      + '(raw HTML, Google Tag Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React).',
   connectSearchConsole: 'Google Search Console is an optional richer layer, not the first step. It gives real impression '
      + 'and click data (read via get_insight) beyond the keywords you track explicitly. It is connected after first value '
      + 'because the service-account flow is slower than the Serper-key rank path that onboarding leads with.',
   installGuidesSource: 'The exact tracking snippet and per-platform steps come from getInstallGuides(domain, websiteId) in '
      + 'utils/install-guides.ts, surfaced at runtime by the install_instructions capability (GET /api/install-instructions). '
      + 'That library is the single source for install copy; ask install_instructions for the live, domain-specific version.',
};

// ---------------------------------------------------------------------------
// Reasoning (honest "why", grounded in BUILD_PLAN.md and SECURITY.md).
// ---------------------------------------------------------------------------
const reasoning: ReasoningEntry[] = [
   {
      id: 'why_mcp_first',
      question: 'Why is s33k controlled from an LLM over MCP instead of a dashboard?',
      answer: 'Because the product is the unified control plane that joins SEO rank, analytics traffic, and AI visibility, '
         + 'and that join is most useful as an answer, not a chart. s33k does the joins and the rules-based prioritization '
         + 'on the server and hands the structured result to YOUR OWN LLM over MCP, which narrates it. A passive dashboard '
         + 'cannot answer "what happened, why, and what should I do" across all three pillars; an LLM with the joined data '
         + 'can. The whole product is controllable from MCP with no UI.',
   },
   {
      id: 'why_serper',
      question: 'Why does s33k use Serper for rankings instead of asking the user to configure a scraper?',
      answer: 'The 5-minutes-to-value bar. Serper is one API key held server-side: paste a domain, add keywords, see live '
         + 'Google rankings in about two minutes, with no scraper settings exposed to the user. s33k runs the SERP infra so '
         + 'onboarding is "give me your domain," not "configure a scraping backend."',
   },
   {
      id: 'why_cookieless_umami',
      question: 'Why self-hosted cookieless Umami analytics instead of a hosted analytics vendor?',
      answer: 'Two reasons: data ownership and privacy. Self-hosting Umami means the analytics data lives in a database you '
         + 'can own, not a third party. Cookieless, no-PII tracking (the autocapture script uses no cookies and no '
         + 'fingerprinting, and never reads typed values) means a marketer can start a trial with zero privacy fear. It is '
         + 'the analytics substrate s33k builds its AI-native signals on top of.',
   },
   {
      id: 'why_no_llm_training',
      question: 'Why is "we do not train on your data" structurally true and not just a policy?',
      answer: 'Because s33k has no model-training pipeline, no LLM client, and no embedding or fine-tuning step anywhere in '
         + 'the codebase. The AI features (briefing, insights, ai_visibility) are rules-based: s33k runs transparent rules '
         + 'over your own data and hands the structured result to your own LLM for interpretation. Since s33k is open source '
         + 'and self-hostable, you can verify this by reading the code or owning the deployment.',
   },
   {
      id: 'why_caps_and_invites',
      question: 'Why the keyword caps, the invite-only model, and the external-invite quota?',
      answer: 'Because s33k runs the SERP and LLM-adjacent infrastructure server-side, so cost ceilings are a day-one design '
         + 'input. Enforced per-domain and per-request keyword caps and a default external-invite quota of 5 bound the cost of '
         + 'the infrastructure s33k pays for and double as the free-to-paid lever. Internal read-only member seats are '
         + 'unlimited because they add no SERP cost. The invite model is also the growth lever: external invites bring new '
         + 'accounts in.',
   },
   {
      id: 'why_open_source',
      question: 'Why is s33k open source and self-hostable?',
      answer: 'The principle is "verify us, don\'t trust us." Open source means you can read every line of code that touches '
         + 'your data; self-hostable means you can run the whole thing on your own infrastructure with your own database so '
         + 'your data never leaves your control. It is the strongest form of a trust guarantee: not asserted, verifiable.',
   },
];

// ---------------------------------------------------------------------------
// Troubleshooting (common issues and fixes).
// ---------------------------------------------------------------------------
const troubleshooting: TroubleshootingEntry[] = [
   {
      id: 'rankings_pending',
      problem: 'I added keywords (or onboarded a domain) but the rankings show 0 or "not ranked".',
      resolution: 'Rank scrapes run in the background, so rankings appear shortly after, not instantly (onboarding returns '
         + 'rankingsPending: true while it works). Re-read with list_keywords a moment later. A position of 0 means the '
         + 'keyword has not scraped yet OR the site is not in the top 100 for that term (an opportunity, not an error). '
         + 'Use refresh_keywords to force a re-scrape.',
   },
   {
      id: 'empty_ai_funnel',
      problem: 'My AI visibility / AI referrals / AI crawlers come back empty.',
      resolution: 'AEO measurement is first-party and new: s33k reports AI crawls and AI referrals it has actually recorded, '
         + 'and it only starts recording them once the tracking script is on the site and AI engines begin crawling or '
         + 'referring. Empty early on is expected, not a bug. AI crawls (ai_crawlers) show up before AI referrals '
         + '(ai_referrals), so a healthy crawl count with zero referrals is the normal early state. When first-party data is '
         + 'thin, ai_visibility falls back to a deterministic AI-readiness audit so you still get a signal.',
   },
   {
      id: 'analytics_needs_script',
      problem: 'Traffic, engagement, scroll depth, or click data is all zeros.',
      resolution: 'Analytics and autocapture only flow once the tracking script is installed on the site. Call '
         + 'install_instructions for your platform, add the snippet, load any page once, then check again in a few minutes. '
         + 'Without the script s33k has no events to report.',
   },
   {
      id: 'member_key_read_only',
      problem: 'A write action (add/update/delete, invite, onboard) is rejected with "Read-only member".',
      resolution: 'You are using a read-only MEMBER API key (the kind an internal invite mints). Member keys can read every '
         + 'analytics and SEO surface but cannot change anything or invite anyone. Use an ADMIN API key for writes, invites, '
         + 'onboarding, and account management.',
   },
   {
      id: 'route_not_accessible',
      problem: 'A tool fails with "This Route cannot be accessed with API."',
      resolution: 'That capability is not exposed to API-key callers (only a small whitelist is). If it is a tool you expect '
         + 'to work, the route may be missing from the API-key whitelist (utils/allowedApiRoutes.ts). Public, pre-account '
         + 'flows (collect, invite accept, waitlist signup) are intentionally not key-callable.',
   },
   {
      id: 'search_console_not_connected',
      problem: 'get_insight returns "Google Search Console is not Integrated".',
      resolution: 'get_insight needs Google Search Console connected for that domain. It is an optional level-2 layer, not '
         + 'part of the fast onboarding path. Connect Search Console in s33k for the domain, then get_insight returns real '
         + 'impression and click data.',
   },
];

// ---------------------------------------------------------------------------
// Trust (references the single securityFacts source; does not duplicate it).
// ---------------------------------------------------------------------------
const trust = {
   summary: 'Start a trial with zero security fear. s33k cannot train on your data (no model-training pipeline exists), one '
      + 'account can never see another\'s (proven by adversarial isolation tests), connected credentials are encrypted at '
      + 'rest, tracking is cookieless with no PII, and you can export or hard-delete everything on demand. Every claim is '
      + 'verifiable because s33k is open source and self-hostable. The full, source-cited facts come from '
      + 'utils/securityFacts.ts (also served by the security_facts capability).',
   facts: securityFacts,
};

// ---------------------------------------------------------------------------
// Pricing / limits / privacy (high level).
// ---------------------------------------------------------------------------
const pricingAndLimits = {
   model: 's33k is open source and self-hostable: run it yourself on your own infrastructure and database, free. The '
      + 'managed hosted service (s33k.io) is the paid surface (open-core). When self-hosting, you supply your own Serper '
      + 'key and host, so your only cost is your infrastructure.',
   keywordTracking: 'Keyword tracking is bounded by enforced per-domain and per-request caps (configurable; defaults 200 '
      + 'per domain and 50 per request, see utils/limits.ts), because s33k runs the SERP infrastructure server-side. '
      + 'Onboarding adds up to 20 discovered keywords per domain automatically.',
   externalInvites: 'External invites (which create brand-new accounts) are limited per account by a quota, default 5. '
      + 'Internal read-only member seats are unlimited and do not consume the external quota.',
   memberSeats: 'A member seat is read-only: it can read every SEO and analytics surface but cannot write, invite, onboard, '
      + 'or manage the account. Admin keys have full access.',
   privacy: 'Tracking is cookieless and collects no PII: no cookies, no fingerprinting, the session id lives in '
      + 'sessionStorage and rotates daily, typed values are never read, and the server drops anything PII-shaped before '
      + 'storing it. s33k never trains on your data and never sends it to a model.',
};

const knowledge: KnowledgeBase = {
   capabilities,
   setup,
   reasoning,
   troubleshooting,
   trust,
   pricingAndLimits,
};

/** The topics a help query can be scoped to. */
export type HelpTopic = KnowledgeBase['capabilities'][number]['category']
   | 'setup' | 'reasoning' | 'troubleshooting' | 'trust' | 'pricing';

/**
 * Search the knowledge base for entries relevant to a free-text query, optionally scoped to a
 * topic. Returns a structured slice of the knowledge base: the matching capabilities plus the
 * setup, reasoning, troubleshooting, trust, and pricing context that matched. Pure and
 * dependency-free so GET /api/help can call it cheaply; never throws and never returns an empty
 * shape (it falls back to the full capability catalog when nothing matches, so the LLM always
 * has something to work with).
 * @param {string} q - The user's free-text question.
 * @param {string} [topic] - Optional category/section to scope the search to.
 * @returns The matching knowledge slice.
 */
export const searchKnowledge = (q: string, topic?: string) => {
   const query = String(q || '').toLowerCase().trim();
   const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
   const wantTopic = String(topic || '').toLowerCase().trim();

   const matchesText = (...parts: string[]): number => {
      if (terms.length === 0) { return 0; }
      const hay = parts.join(' ').toLowerCase();
      return terms.reduce((score, term) => (hay.includes(term) ? score + 1 : score), 0);
   };

   const isCategory = (['seo', 'aeo', 'analytics', 'cross-pillar', 'onboarding', 'account', 'security'] as const)
      .some((c) => c === wantTopic);

   // Capabilities: filter by topic when a category topic is given, then rank by query overlap.
   // With no query terms (the listable-resource case) return the full scoped catalog, not a
   // truncated slice, so the capabilities resource is a complete doc. With a query, rank by
   // overlap and return the top matches.
   const scopedCaps = isCategory ? capabilities.filter((c) => c.category === wantTopic) : capabilities;
   let matchedCapabilities: CapabilityEntry[];
   if (terms.length === 0) {
      matchedCapabilities = scopedCaps;
   } else {
      const rankedCaps = scopedCaps
         .map((c) => ({ entry: c, score: matchesText(c.toolName, c.title, c.description, c.whenToUse, c.examplePrompt) }))
         .sort((a, b) => b.score - a.score);
      const anyCapMatch = rankedCaps.some((c) => c.score > 0);
      matchedCapabilities = (anyCapMatch ? rankedCaps.filter((c) => c.score > 0) : rankedCaps)
         .slice(0, 8)
         .map((c) => c.entry);
   }

   // A category topic (seo/aeo/...) suppresses the prose sections; a section topic or a
   // free-text query surfaces the sections that match. With no topic and no query, return
   // everything so the caller always has a useful slice.
   const matchedReasoning = isCategory
      ? []
      : reasoning.filter((r) => (terms.length === 0 ? (!wantTopic || wantTopic === 'reasoning') : matchesText(r.question, r.answer) > 0));
   const matchedTroubleshooting = isCategory
      ? []
      : troubleshooting.filter((t) => (terms.length === 0
         ? (!wantTopic || wantTopic === 'troubleshooting')
         : matchesText(t.problem, t.resolution) > 0));

   const wantsSetup = wantTopic === 'setup' || wantTopic === 'onboarding'
      || (!wantTopic && terms.length === 0)
      || /install|setup|track|snippet|onboard|connect|deploy/.test(query);
   const wantsTrust = wantTopic === 'trust' || wantTopic === 'security'
      || (!wantTopic && terms.length === 0)
      || /safe|secure|privacy|private|trust|train|encrypt|gdpr|data/.test(query);
   const wantsPricing = wantTopic === 'pricing'
      || (!wantTopic && terms.length === 0)
      || /price|pricing|cost|plan|limit|quota|free|paid|seat/.test(query);

   return {
      query: q,
      topic: topic || null,
      capabilities: matchedCapabilities,
      reasoning: matchedReasoning,
      troubleshooting: matchedTroubleshooting,
      setup: wantsSetup ? setup : null,
      trust: wantsTrust ? trust : null,
      pricingAndLimits: wantsPricing ? pricingAndLimits : null,
   };
};

/** The result of cross-checking a feature request against the capability index. */
export type CapabilityMatch = {
   /** True when the request text strongly matches a capability s33k already ships. */
   matched: boolean,
   /** The best-matching capability when matched is true, else null. */
   capability: CapabilityEntry | null,
   /** Raw overlap score of the best match (0 when nothing overlapped). */
   score: number,
};

// The single significant-term tokenizer used by both search and cross-check, so "is this
// already a capability?" is answered the same way "what capability answers this?" is. Drops
// very short tokens and a small stoplist of feature-request filler so the overlap signal is
// dominated by meaningful words (the verb and the noun the user actually wants).
const STOPWORDS = new Set([
   'the', 'and', 'for', 'with', 'that', 'this', 'have', 'has', 'can', 'could', 'would', 'should',
   'want', 'need', 'like', 'add', 'support', 'feature', 'please', 'able', 'ability', 's33k', 'tool',
   'from', 'into', 'about', 'when', 'what', 'how', 'does', 'will', 'are', 'you', 'your', 'our', 'all',
   'get', 'see', 'show', 'give', 'make', 'use', 'using', 'data', 'page', 'pages', 'site',
]);

const significantTerms = (text: string): string[] => String(text || '')
   .toLowerCase()
   .split(/[^a-z0-9]+/)
   .filter((t) => t.length > 2 && !STOPWORDS.has(t));

// The meta / self-support tools are NOT product features a user would ask for, so the
// cross-check never maps a feature request onto them. Crucially this also stops the gate from
// matching a request onto request_feature itself (its own description mentions export/rank/etc).
const META_TOOL_IDS = new Set(['help', 'request_feature', 'list_feature_requests']);

/**
 * Cross-check a free-text feature request against the capability index, the server-side safety
 * net behind request_feature. It answers one question: does s33k ALREADY ship something that
 * does this? If a capability overlaps the request strongly enough, return it so the caller can
 * push back ("this may already be supported via X") instead of storing a duplicate. Pure, never
 * throws. This is the single source for the "does it exist?" check, so the help tool, the
 * coverage test, and the feature-request gate all reason over the same catalog.
 *
 * Matching is deliberately conservative on BOTH ends: it requires at least two overlapping
 * significant terms (so a single incidental word like "keyword" cannot trigger a false match)
 * AND a clear lead over the runner-up (so an ambiguous request is treated as new, not silently
 * mapped to a capability), because a false "already exists" wrongly blocks a real request, which
 * is worse here than letting a borderline one through to a human.
 * @param {string} request - The user's feature-request text.
 * @returns {CapabilityMatch} Whether it matches an existing capability, and which one.
 */
export const crossCheckCapability = (request: string): CapabilityMatch => {
   const terms = significantTerms(request);
   if (terms.length === 0) {
      return { matched: false, capability: null, score: 0 };
   }
   const unique = Array.from(new Set(terms));
   const ranked = capabilities
      .filter((c) => !META_TOOL_IDS.has(c.id))
      .map((c) => {
         const hay = significantTerms([c.toolName, c.title, c.description, c.whenToUse, c.examplePrompt].join(' '));
         const haySet = new Set(hay);
         const score = unique.reduce((acc, term) => (haySet.has(term) ? acc + 1 : acc), 0);
         return { entry: c, score };
      })
      .sort((a, b) => b.score - a.score);

   const best = ranked[0];
   const runnerUp = ranked[1] ? ranked[1].score : 0;
   // Strong match = at least two meaningful overlapping terms AND a clear lead over the next
   // capability. Otherwise the request is treated as genuinely new and allowed through to store.
   const matched = best.score >= 2 && best.score > runnerUp;
   return { matched, capability: matched ? best.entry : null, score: best.score };
};

export default knowledge;
