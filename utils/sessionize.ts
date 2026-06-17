// Sessionize + segment + goal-match: the shared engine behind human-only analytics and named
// conversion goals. It turns the flat first-party event stream (s33k_event rows) into per-session
// aggregates carrying every segment dimension (channel, landing page, device, country, human/bot,
// engagement), applies a composable filter set, and evaluates whether a session completed a goal.
//
// One engine, used by /api/human-analytics and /api/goal-analytics, so traffic and conversion
// questions share exactly the same filter vocabulary and never diverge.

export type EventLike = {
   session: string,
   source: string | null,
   is_bot: boolean,
   device: string | null,
   country: string | null,
   page: string,
   type: string,
   created: string,
};

export type SessionAgg = {
   id: string,
   channel: string, // normalized: 'direct' | 'referral' | 'organic-search' | 'ai'
   isBot: boolean,
   device: string,
   country: string,
   landingPage: string, // first pageview path (falls back to first event page)
   exitPage: string, // last pageview path
   pageviewPaths: string[],
   eventTypes: Set<string>,
   pageEvents: { type: string, page: string }[], // for event-on-page goal matching
   pageviewCount: number,
   hasNonPageviewEvent: boolean,
};

export type SegmentFilters = {
   humanOnly?: boolean, // default applied by the route, not here
   channel?: string, // 'direct' | 'referral' | 'organic-search' | 'ai'
   landingPage?: string, // exact landing-page path
   page?: string, // session viewed this path at least once
   device?: string, // 'mobile' | 'tablet' | 'desktop'
   country?: string, // ISO code (uppercased)
   engagement?: 'engaged' | 'bounced',
};

export type GoalDef = {
   kind: 'page_reached' | 'event',
   matchValue: string,
   matchPage?: string | null,
   matchMode?: 'prefix' | 'exact',
};

// Normalize a stored source (a SOURCE_CLASS, a bare referrer host, or empty) into a channel.
// Empty/absent is direct; a bare host is referral; the known classes pass through.
const KNOWN_CHANNELS = new Set(['direct', 'referral', 'organic-search', 'ai']);
export const normalizeChannel = (source: string | null | undefined): string => {
   const s = String(source || '').trim().toLowerCase();
   if (!s) { return 'direct'; }
   if (KNOWN_CHANNELS.has(s)) { return s; }
   return 'referral';
};

// Map a user-supplied channel alias ("seo", "aio", "organic") to a canonical channel.
export const canonicalChannel = (input: string): string => {
   const s = String(input || '').trim().toLowerCase();
   if (['seo', 'organic', 'organic-search', 'search'].includes(s)) { return 'organic-search'; }
   if (['ai', 'aio', 'ai-search', 'aeo', 'llm'].includes(s)) { return 'ai'; }
   if (['direct', 'none'].includes(s)) { return 'direct'; }
   if (['referral', 'ref'].includes(s)) { return 'referral'; }
   return s;
};

/**
 * Group event rows into per-session aggregates. Rows are sorted by `created` here, so callers do
 * not need to pre-sort. Segment dimensions (channel/device/country/is_bot) are taken from the
 * session's first row (they are constant per session). landingPage is the first PAGEVIEW (falling
 * back to the first event when a legacy session has no pageview row).
 * @param {EventLike[]} rows - Raw event rows for a domain+window.
 * @returns {SessionAgg[]}
 */
export const sessionize = (rows: EventLike[]): SessionAgg[] => {
   const sorted = [...rows].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
   const map = new Map<string, EventLike[]>();
   for (const r of sorted) {
      const key = r.session || `anon-${r.created}`;
      if (!map.has(key)) { map.set(key, []); }
      (map.get(key) as EventLike[]).push(r);
   }
   const out: SessionAgg[] = [];
   for (const [id, evs] of map.entries()) {
      const first = evs[0];
      const pageviews = evs.filter((e) => e.type === 'pageview');
      const pageviewPaths = pageviews.map((e) => e.page);
      const landingPage = (pageviews[0]?.page) ?? first.page;
      const exitPage = (pageviews[pageviews.length - 1]?.page) ?? first.page;
      const eventTypes = new Set(evs.map((e) => e.type));
      out.push({
         id,
         channel: normalizeChannel(first.source),
         isBot: Boolean(first.is_bot),
         device: String(first.device || ''),
         country: String(first.country || '').toUpperCase(),
         landingPage,
         exitPage,
         pageviewPaths,
         eventTypes,
         pageEvents: evs.filter((e) => e.type !== 'pageview').map((e) => ({ type: e.type, page: e.page })),
         pageviewCount: pageviews.length,
         hasNonPageviewEvent: evs.some((e) => e.type !== 'pageview'),
      });
   }
   return out;
};

/**
 * Parse the composable segment filters from a request query object (shared by the analytics
 * routes so the filter vocabulary never diverges). humanOnly is set by the route, not here.
 * Accepts `channel` or its alias `source`; normalizes device to lowercase and country to upper.
 * @param {Record<string, unknown>} q - The request query.
 * @returns {SegmentFilters}
 */
export const parseSegmentFilters = (q: Record<string, unknown>): SegmentFilters => {
   const str = (k: string): string | undefined => {
      const v = q[k];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
   };
   const channelRaw = str('channel') || str('source');
   const eng = str('engagement');
   return {
      channel: channelRaw ? canonicalChannel(channelRaw) : undefined,
      landingPage: str('landingPage'),
      page: str('page'),
      device: str('device')?.toLowerCase(),
      country: str('country')?.toUpperCase(),
      engagement: eng === 'engaged' || eng === 'bounced' ? eng : undefined,
   };
};

/**
 * Apply the composable segment filters to sessionized data. Any unset filter is a no-op, so
 * filters compose ("human + organic-search + mobile"). humanOnly is honored here too when set.
 * @param {SessionAgg[]} sessions - Sessionized data.
 * @param {SegmentFilters} f - The filter set.
 * @returns {SessionAgg[]}
 */
export const applyFilters = (sessions: SessionAgg[], f: SegmentFilters): SessionAgg[] => sessions.filter((s) => {
   if (f.humanOnly && s.isBot) { return false; }
   if (f.channel && s.channel !== f.channel) { return false; }
   if (f.landingPage && s.landingPage !== f.landingPage) { return false; }
   if (f.page && !s.pageviewPaths.includes(f.page)) { return false; }
   if (f.device && s.device !== f.device) { return false; }
   if (f.country && s.country !== String(f.country).toUpperCase()) { return false; }
   if (f.engagement === 'engaged' && !(s.pageviewCount > 1 || s.hasNonPageviewEvent)) { return false; }
   if (f.engagement === 'bounced' && (s.pageviewCount > 1 || s.hasNonPageviewEvent)) { return false; }
   return true;
});

/**
 * Did a session complete a goal? page_reached matches a viewed path (prefix by default, or exact);
 * event matches a fired event type, optionally constrained to a page (prefix).
 * @param {SessionAgg} s - A sessionized session.
 * @param {GoalDef} goal - The goal definition.
 * @returns {boolean}
 */
export const sessionConverted = (s: SessionAgg, goal: GoalDef): boolean => {
   if (goal.kind === 'page_reached') {
      const want = goal.matchValue;
      return s.pageviewPaths.some((p) => (goal.matchMode === 'exact' ? p === want : p.startsWith(want)));
   }
   // event kind
   if (!s.eventTypes.has(goal.matchValue)) { return false; }
   if (goal.matchPage) {
      return s.pageEvents.some((e) => e.type === goal.matchValue && e.page.startsWith(goal.matchPage as string));
   }
   return true;
};
