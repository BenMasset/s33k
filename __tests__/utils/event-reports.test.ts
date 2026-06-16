/**
 * Pure aggregation tests for utils/eventReports.ts, the shaping logic behind the four
 * autocapture read surfaces (top_clicks, form_submissions, scroll_depth, page_engagement).
 * No DB, no HTTP: the functions take plain rows and return JSON-ready reports.
 */

import {
   eventPeriodCutoff,
   buildTopClicks,
   buildFormSubmissions,
   buildScrollDepth,
   buildPageEngagement,
   EventRow,
} from '../../utils/eventReports';

const row = (over: Partial<EventRow>): EventRow => ({
   type: 'click',
   page: '/p',
   label: '',
   selector: '',
   value: null,
   session: 's1',
   created: new Date().toJSON(),
   ...over,
});

describe('eventPeriodCutoff', () => {
   it('returns an ISO string earlier than now for a valid period', () => {
      const cutoff = eventPeriodCutoff('7d');
      expect(typeof cutoff).toBe('string');
      expect(new Date(cutoff).getTime()).toBeLessThan(Date.now());
   });

   it('a longer window has an earlier cutoff than a shorter one', () => {
      expect(new Date(eventPeriodCutoff('90d')).getTime()).toBeLessThan(new Date(eventPeriodCutoff('7d')).getTime());
   });

   it('falls back to a 30-day window for an unparseable period', () => {
      const cutoff = new Date(eventPeriodCutoff('garbage')).getTime();
      const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
      // within a few seconds of a 30d cutoff
      expect(Math.abs(cutoff - expected)).toBeLessThan(10000);
   });
});

describe('buildTopClicks', () => {
   it('counts clicks per label+selector, sorts desc, and breaks down by page', () => {
      const rows = [
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/a' }),
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/a' }),
         row({ type: 'click', label: 'Buy', selector: 'button.cta', page: '/b' }),
         row({ type: 'click', label: 'Docs', selector: 'a.nav', page: '/a' }),
         row({ type: 'scroll', value: 50, page: '/a' }), // ignored: wrong type
      ];
      const out = buildTopClicks(rows);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ label: 'Buy', selector: 'button.cta', clickCount: 3 });
      expect(out[0].byPage).toEqual([{ page: '/a', count: 2 }, { page: '/b', count: 1 }]);
      expect(out[1]).toMatchObject({ label: 'Docs', clickCount: 1 });
   });

   it('respects the limit', () => {
      const rows = Array.from({ length: 5 }, (_, i) => row({ type: 'click', label: `L${i}`, selector: `s${i}` }));
      expect(buildTopClicks(rows, 2)).toHaveLength(2);
   });
});

describe('buildFormSubmissions', () => {
   it('counts submissions per form and totals them, ignoring other types', () => {
      const rows = [
         row({ type: 'form_submit', label: 'signup', page: '/a' }),
         row({ type: 'form_submit', label: 'signup', page: '/b' }),
         row({ type: 'form_submit', label: 'contact', page: '/c' }),
         row({ type: 'click', label: 'signup' }), // ignored
      ];
      const { forms, totalSubmissions } = buildFormSubmissions(rows);
      expect(totalSubmissions).toBe(3);
      expect(forms[0]).toMatchObject({ label: 'signup', submissionCount: 2 });
      expect(forms[1]).toMatchObject({ label: 'contact', submissionCount: 1 });
   });

   it('labels an unnamed form "form"', () => {
      const { forms } = buildFormSubmissions([row({ type: 'form_submit', label: '' })]);
      expect(forms[0].label).toBe('form');
   });
});

describe('buildScrollDepth', () => {
   it('averages and maxes scroll percent per page and builds a histogram', () => {
      const rows = [
         row({ type: 'scroll', value: 20, page: '/a', session: 's1' }),
         row({ type: 'scroll', value: 80, page: '/a', session: 's2' }),
         row({ type: 'scroll', value: 100, page: '/b', session: 's3' }),
      ];
      const { pages, distribution } = buildScrollDepth(rows);
      const a = pages.find((p) => p.page === '/a');
      expect(a).toMatchObject({ avgScrollDepth: 50, maxScrollDepth: 80, sessions: 2 });
      expect(distribution).toEqual({ '0-25': 1, '25-50': 0, '50-75': 0, '75-100': 2 });
   });

   it('clamps out-of-range values into 0-100', () => {
      const { pages } = buildScrollDepth([row({ type: 'scroll', value: 250, page: '/a' })]);
      expect(pages[0].maxScrollDepth).toBe(100);
   });
});

describe('buildPageEngagement', () => {
   it('sums and averages active seconds per page and computes a site average', () => {
      const rows = [
         row({ type: 'engagement', value: 10, page: '/a', session: 's1' }),
         row({ type: 'engagement', value: 30, page: '/a', session: 's2' }),
         row({ type: 'engagement', value: 20, page: '/b', session: 's3' }),
      ];
      const { pages, siteAvgEngagementSeconds } = buildPageEngagement(rows);
      const a = pages.find((p) => p.page === '/a');
      expect(a).toMatchObject({ avgEngagementSeconds: 20, totalEngagementSeconds: 40, sessions: 2 });
      // sorted by total desc, so /a is first
      expect(pages[0].page).toBe('/a');
      expect(siteAvgEngagementSeconds).toBe(20); // 60 secs across 3 sessions
   });

   it('returns 0 site average with no engagement rows', () => {
      const { pages, siteAvgEngagementSeconds } = buildPageEngagement([row({ type: 'click' })]);
      expect(pages).toHaveLength(0);
      expect(siteAvgEngagementSeconds).toBe(0);
   });
});
