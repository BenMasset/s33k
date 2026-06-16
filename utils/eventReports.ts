// Aggregations over the s33k_event table (the GA4-killer autocapture store).
//
// The route layer (pages/api/top-clicks.ts, form-submissions.ts, scroll-depth.ts,
// page-engagement.ts) stays a thin ownership gate + DB read; ALL of the shaping logic
// lives here so it is pure and unit-testable without HTTP, mirroring how the rest of the
// app keeps logic in utils/ and gates in pages/api/.
//
// Every function takes already-loaded plain event rows (scoped + period-filtered by the
// caller) and returns a JSON-ready report. Nothing here touches the DB, the network, or
// any LLM. owner_id scoping happens in the route via scopeWhere; these functions never
// see another tenant's rows.

// One plain s33k_event row as read with { raw: true }. value/selector are nullable.
export type EventRow = {
   type: string,
   page: string | null,
   label: string | null,
   selector: string | null,
   value: number | null,
   session: string | null,
   created: string,
}

// Parse a period string ("30d", "7d", "12h", "4w", "3m") into the earliest `created`
// ISO timestamp to include. Anything unparseable falls back to a 30-day window. This is
// the same grammar the analytics providers and the crawler reports use, so an event
// window matches a traffic window for the same period string.
export const eventPeriodCutoff = (period: string): string => {
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   let days = 30;
   if (match) {
      const n = Number(match[1]);
      const unit = match[2].toLowerCase();
      const perUnitDays: Record<string, number> = { h: n / 24, d: n, w: n * 7, m: n * 30 };
      days = perUnitDays[unit] ?? 30;
   }
   const ms = Math.max(1, days) * 24 * 60 * 60 * 1000;
   return new Date(Date.now() - ms).toJSON();
};

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// top_clicks: the most-clicked elements, each keyed by its visible text + selector,
// with a per-page breakdown so you can see where a given CTA is clicked.
// ---------------------------------------------------------------------------
export type TopClickRow = {
   label: string,
   selector: string,
   clickCount: number,
   byPage: Array<{ page: string, count: number }>,
}

export const buildTopClicks = (rows: EventRow[], limit = 100): TopClickRow[] => {
   const map = new Map<string, TopClickRow & { _pages: Map<string, number> }>();
   rows.forEach((row) => {
      if (row.type !== 'click') { return; }
      const label = (row.label || '').trim();
      const selector = (row.selector || '').trim();
      const page = (row.page || '').trim();
      const key = `${label} ${selector}`;
      let entry = map.get(key);
      if (!entry) {
         entry = { label, selector, clickCount: 0, byPage: [], _pages: new Map<string, number>() };
         map.set(key, entry);
      }
      entry.clickCount += 1;
      entry._pages.set(page, (entry._pages.get(page) || 0) + 1);
   });
   const out = Array.from(map.values()).map((entry) => ({
      label: entry.label,
      selector: entry.selector,
      clickCount: entry.clickCount,
      byPage: Array.from(entry._pages.entries())
         .map(([page, count]) => ({ page, count }))
         .sort((a, b) => b.count - a.count),
   }));
   out.sort((a, b) => b.clickCount - a.clickCount);
   return out.slice(0, limit);
};

// ---------------------------------------------------------------------------
// form_submissions: how often each form was submitted, plus a per-page breakdown.
// ---------------------------------------------------------------------------
export type FormSubmissionRow = {
   label: string,
   submissionCount: number,
   byPage: Array<{ page: string, count: number }>,
}

export const buildFormSubmissions = (rows: EventRow[]): { forms: FormSubmissionRow[], totalSubmissions: number } => {
   const map = new Map<string, FormSubmissionRow & { _pages: Map<string, number> }>();
   let total = 0;
   rows.forEach((row) => {
      if (row.type !== 'form_submit') { return; }
      total += 1;
      const label = (row.label || '').trim() || 'form';
      const page = (row.page || '').trim();
      let entry = map.get(label);
      if (!entry) {
         entry = { label, submissionCount: 0, byPage: [], _pages: new Map<string, number>() };
         map.set(label, entry);
      }
      entry.submissionCount += 1;
      entry._pages.set(page, (entry._pages.get(page) || 0) + 1);
   });
   const forms = Array.from(map.values()).map((entry) => ({
      label: entry.label,
      submissionCount: entry.submissionCount,
      byPage: Array.from(entry._pages.entries())
         .map(([page, count]) => ({ page, count }))
         .sort((a, b) => b.count - a.count),
   }));
   forms.sort((a, b) => b.submissionCount - a.submissionCount);
   return { forms, totalSubmissions: total };
};

// ---------------------------------------------------------------------------
// scroll_depth: per-page average and max scroll percent, plus a site-wide histogram.
// value on a scroll event is the max scroll percent (0-100) for that session/page.
// ---------------------------------------------------------------------------
export type ScrollDepthRow = {
   page: string,
   avgScrollDepth: number,
   maxScrollDepth: number,
   sessions: number,
}

export type ScrollDistribution = {
   '0-25': number,
   '25-50': number,
   '50-75': number,
   '75-100': number,
}

export const buildScrollDepth = (rows: EventRow[]): { pages: ScrollDepthRow[], distribution: ScrollDistribution } => {
   const map = new Map<string, { sum: number, max: number, sessions: Set<string> }>();
   const distribution: ScrollDistribution = { '0-25': 0, '25-50': 0, '50-75': 0, '75-100': 0 };
   rows.forEach((row) => {
      if (row.type !== 'scroll') { return; }
      const page = (row.page || '').trim();
      const pct = Math.max(0, Math.min(100, num(row.value)));
      let entry = map.get(page);
      if (!entry) {
         entry = { sum: 0, max: 0, sessions: new Set<string>() };
         map.set(page, entry);
      }
      entry.sum += pct;
      if (pct > entry.max) { entry.max = pct; }
      entry.sessions.add((row.session || '').trim());
      if (pct < 25) { distribution['0-25'] += 1; }
      else if (pct < 50) { distribution['25-50'] += 1; }
      else if (pct < 75) { distribution['50-75'] += 1; }
      else { distribution['75-100'] += 1; }
   });
   const pages = Array.from(map.entries()).map(([page, entry]) => {
      const count = entry.sessions.size || 1;
      return {
         page,
         avgScrollDepth: round1(entry.sum / Math.max(1, count)),
         maxScrollDepth: round1(entry.max),
         sessions: entry.sessions.size,
      };
   });
   pages.sort((a, b) => b.avgScrollDepth - a.avgScrollDepth);
   return { pages, distribution };
};

// ---------------------------------------------------------------------------
// page_engagement: per-page average and total active engagement seconds.
// value on an engagement event is summed active seconds for that session/page.
// ---------------------------------------------------------------------------
export type PageEngagementRow = {
   page: string,
   avgEngagementSeconds: number,
   totalEngagementSeconds: number,
   sessions: number,
}

export const buildPageEngagement = (rows: EventRow[]): { pages: PageEngagementRow[], siteAvgEngagementSeconds: number } => {
   const map = new Map<string, { sum: number, sessions: Set<string> }>();
   let siteSum = 0;
   let siteSessions = 0;
   rows.forEach((row) => {
      if (row.type !== 'engagement') { return; }
      const page = (row.page || '').trim();
      const secs = Math.max(0, num(row.value));
      let entry = map.get(page);
      if (!entry) {
         entry = { sum: 0, sessions: new Set<string>() };
         map.set(page, entry);
      }
      entry.sum += secs;
      entry.sessions.add((row.session || '').trim());
      siteSum += secs;
   });
   const pages = Array.from(map.entries()).map(([page, entry]) => {
      const sessions = entry.sessions.size;
      siteSessions += sessions;
      return {
         page,
         avgEngagementSeconds: round1(entry.sum / Math.max(1, sessions)),
         totalEngagementSeconds: round1(entry.sum),
         sessions,
      };
   });
   pages.sort((a, b) => b.totalEngagementSeconds - a.totalEngagementSeconds);
   return { pages, siteAvgEngagementSeconds: round1(siteSum / Math.max(1, siteSessions)) };
};
