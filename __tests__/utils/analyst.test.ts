/**
 * Tests for the proactive-analyst change-detection engine (utils/analyst.ts).
 *
 * detectChanges is a PURE function: given a current period and a prior period
 * across all four pillars (rank, traffic, AI visibility, conversions), it returns
 * a prioritized list of plain-English alerts plus the single most important thing
 * to do. No DB, no network, no LLM, no clock, no randomness, so it is exhaustively
 * testable from its inputs alone.
 *
 * Contract under test:
 *   1. RANK: page-one crossings (high), >= 5-position moves (medium), newly-ranked
 *      and newly-dropped keywords, and SILENCE when there is no prior reading.
 *   2. TRAFFIC: a >= 25% swing (medium) / >= 50% swing (high) off a NON-ZERO prior
 *      baseline; silence when the prior baseline is zero.
 *   3. AI: a brand-new referring engine fires HIGH off a zero prior (the one rule
 *      that fires "from nothing"); existing-engine >= 30% moves.
 *   4. CONVERSIONS: a >= 30% form-submission change (drop = high, rise = medium),
 *      silent off a zero prior baseline.
 *   5. NO-CHANGE: a quiet period yields zero alerts and a null topPriority (honest).
 *   6. MISSING-DATA: empty/zero pillars never fabricate an alert.
 *   7. PRIORITIZATION: alerts sort highest-signal first (severity, then the stable
 *      rank/traffic/ai/conversions pillar tiebreak), and topPriority is the top
 *      alert's headline + recommendation.
 */

import {
   detectChanges,
   PeriodData,
   KeywordRank,
   AiEngineCount,
} from '../../utils/analyst';

/** A fully-quiet period: every pillar present but identical to its pair, so nothing fires. */
const quietPeriod = (overrides: Partial<PeriodData> = {}): PeriodData => ({
   keywords: [],
   traffic: { pageviews: 100, visitors: 80 },
   aiEngines: [],
   formSubmissions: 10,
   ...overrides,
});

/** Build a current/prior pair from two partials over the same quiet baseline. */
const pair = (cur: Partial<PeriodData>, prior: Partial<PeriodData>) => ({
   current: quietPeriod(cur),
   prior: quietPeriod(prior),
});

const kw = (keyword: string, position: number | null, targetPage?: string): KeywordRank => ({
   keyword, position, targetPage,
});

const ai = (engine: string, visitors: number): AiEngineCount => ({ engine, visitors });

describe('detectChanges: RANK pillar', () => {
   it('flags a high-severity alert when a keyword falls OFF page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 11, '/software/mcp')] },
         { keywords: [kw('DAM MCP server', 4, '/software/mcp')] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/#4 to #11/);
      expect(rank[0].headline).toMatch(/page one/i);
      // The target page is named so the LLM can point at it.
      expect(rank[0].headline).toMatch(/\/software\/mcp/);
   });

   it('flags a high-severity alert when a keyword climbs ONTO page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('AI-ready DAM', 6)] },
         { keywords: [kw('AI-ready DAM', 18)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/#18 to #6/);
      expect(rank[0].headline).toMatch(/page one/i);
   });

   it('flags a medium-severity alert for a >= 5-position move that stays on the same side', () => {
      const { current, prior } = pair(
         { keywords: [kw('Highspot alternative', 30)] },
         { keywords: [kw('Highspot alternative', 22)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('medium');
      expect(rank[0].headline).toMatch(/fell 8 spots/);
      expect(rank[0].headline).toMatch(/#22 to #30/);
   });

   it('does NOT flag a sub-threshold move (4 positions, same side, no crossing)', () => {
      const { current, prior } = pair(
         { keywords: [kw('Seismic alternative', 38)] },
         { keywords: [kw('Seismic alternative', 34)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });

   it('flags newly-ranked (was unranked, now ranks) as a win, high when on page one', () => {
      const { current, prior } = pair(
         { keywords: [kw('how to make website AI readable', 7)] },
         { keywords: [kw('how to make website AI readable', null)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/started ranking at #7/);
   });

   it('flags newly-dropped-off (had a rank, now unranked) as a loss', () => {
      const { current, prior } = pair(
         { keywords: [kw('masset', null)] },
         { keywords: [kw('masset', 3)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].severity).toBe('high');
      expect(rank[0].headline).toMatch(/dropped off/i);
      expect(rank[0].headline).toMatch(/#3/);
   });

   it('treats a position <= 0 as unranked (distinct from a real rank)', () => {
      // current 0 (unranked) vs prior 5 (ranked) is a drop-off, not a "rose 5 spots".
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 0)] },
         { keywords: [kw('DAM MCP server', 5)] },
      );
      const out = detectChanges(current, prior);
      const rank = out.alerts.filter((a) => a.pillar === 'rank');
      expect(rank).toHaveLength(1);
      expect(rank[0].headline).toMatch(/dropped off/i);
   });

   it('stays SILENT for a keyword with no prior reading (a first sighting is not a change)', () => {
      const { current, prior } = pair(
         { keywords: [kw('brand new term', 8)] },
         { keywords: [] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });

   it('stays SILENT when a keyword is unranked in BOTH periods', () => {
      const { current, prior } = pair(
         { keywords: [kw('never ranks', null)] },
         { keywords: [kw('never ranks', null)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'rank')).toHaveLength(0);
   });
});

describe('detectChanges: TRAFFIC pillar', () => {
   it('flags medium for a >= 25% but < 50% swing off a non-zero baseline', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 130, visitors: 80 } }, // +30% pageviews, visitors unchanged
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      const traffic = out.alerts.filter((a) => a.pillar === 'traffic');
      expect(traffic).toHaveLength(1);
      expect(traffic[0].severity).toBe('medium');
      expect(traffic[0].headline).toMatch(/Pageviews rose 30%/);
   });

   it('flags high for a >= 50% swing, and reports pageviews and visitors separately', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 50, visitors: 40 } }, // -50% both
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      const traffic = out.alerts.filter((a) => a.pillar === 'traffic');
      expect(traffic).toHaveLength(2);
      expect(traffic.every((a) => a.severity === 'high')).toBe(true);
      expect(traffic.map((a) => a.headline).join(' ')).toMatch(/Pageviews fell 50%/);
      expect(traffic.map((a) => a.headline).join(' ')).toMatch(/Visitors fell 50%/);
   });

   it('does NOT flag a sub-threshold (< 25%) swing', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 110, visitors: 88 } }, // +10%
         { traffic: { pageviews: 100, visitors: 80 } },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'traffic')).toHaveLength(0);
   });

   it('stays SILENT when the prior baseline is ZERO (no fabricated swing from nothing)', () => {
      const { current, prior } = pair(
         { traffic: { pageviews: 500, visitors: 400 } },
         { traffic: { pageviews: 0, visitors: 0 } },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'traffic')).toHaveLength(0);
   });
});

describe('detectChanges: AI pillar', () => {
   it('flags HIGH when a brand-new AI engine starts referring (fires from a zero prior)', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 12)] },
         { aiEngines: [] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('high');
      expect(aiAlerts[0].headline).toMatch(/ChatGPT started referring/);
   });

   it('flags medium for an existing engine whose referrals move >= 30%', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('Perplexity', 20)] }, // +100%
         { aiEngines: [ai('Perplexity', 10)] },
      );
      const out = detectChanges(current, prior);
      const aiAlerts = out.alerts.filter((a) => a.pillar === 'ai');
      expect(aiAlerts).toHaveLength(1);
      expect(aiAlerts[0].severity).toBe('medium');
      expect(aiAlerts[0].headline).toMatch(/Perplexity referrals grew/);
   });

   it('does NOT flag an existing engine whose referrals move < 30%', () => {
      const { current, prior } = pair(
         { aiEngines: [ai('ChatGPT', 11)] }, // +10%
         { aiEngines: [ai('ChatGPT', 10)] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'ai')).toHaveLength(0);
   });

});

describe('detectChanges: CONVERSIONS pillar', () => {
   it('flags HIGH for a >= 30% DROP in form submissions (a drop is urgent)', () => {
      const { current, prior } = pair(
         { formSubmissions: 6 }, // -40%
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      const conv = out.alerts.filter((a) => a.pillar === 'conversions');
      expect(conv).toHaveLength(1);
      expect(conv[0].severity).toBe('high');
      expect(conv[0].headline).toMatch(/Form submissions fell 40%/);
   });

   it('flags MEDIUM for a >= 30% RISE in form submissions', () => {
      const { current, prior } = pair(
         { formSubmissions: 15 }, // +50%
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      const conv = out.alerts.filter((a) => a.pillar === 'conversions');
      expect(conv).toHaveLength(1);
      expect(conv[0].severity).toBe('medium');
      expect(conv[0].headline).toMatch(/Form submissions rose 50%/);
   });

   it('does NOT flag a sub-threshold (< 30%) conversion change', () => {
      const { current, prior } = pair(
         { formSubmissions: 12 }, // +20%
         { formSubmissions: 10 },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'conversions')).toHaveLength(0);
   });

   it('stays SILENT when the prior submission baseline is ZERO', () => {
      const { current, prior } = pair(
         { formSubmissions: 25 },
         { formSubmissions: 0 },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts.filter((a) => a.pillar === 'conversions')).toHaveLength(0);
   });
});

describe('detectChanges: no-change and missing-data honesty', () => {
   it('returns zero alerts and a null topPriority for a genuinely quiet period', () => {
      const out = detectChanges(quietPeriod(), quietPeriod());
      expect(out.alerts).toEqual([]);
      expect(out.topPriority).toBeNull();
   });

   it('never fabricates an alert when every pillar is empty/zero in both periods', () => {
      const empty: PeriodData = {
         keywords: [], traffic: { pageviews: 0, visitors: 0 }, aiEngines: [], formSubmissions: 0,
      };
      const out = detectChanges(empty, empty);
      expect(out.alerts).toEqual([]);
      expect(out.topPriority).toBeNull();
   });

   it('fires only the pillars that have real deltas, ignoring the quiet ones', () => {
      // Only AI has a change; rank/traffic/conversions are identical baselines.
      const { current, prior } = pair(
         { aiEngines: [ai('Gemini', 9)] },
         { aiEngines: [] },
      );
      const out = detectChanges(current, prior);
      expect(out.alerts).toHaveLength(1);
      expect(out.alerts[0].pillar).toBe('ai');
   });
});

describe('detectChanges: prioritization order', () => {
   it('sorts high-severity alerts before medium ones regardless of pillar', () => {
      // A medium traffic alert AND a high AI alert; the high one must come first.
      const current = quietPeriod({
         traffic: { pageviews: 130, visitors: 80 }, // +30% -> medium traffic
         aiEngines: [ai('ChatGPT', 5)], // new engine -> high ai
      });
      const prior = quietPeriod({
         traffic: { pageviews: 100, visitors: 80 },
         aiEngines: [],
      });
      const out = detectChanges(current, prior);
      expect(out.alerts.length).toBeGreaterThanOrEqual(2);
      expect(out.alerts[0].severity).toBe('high');
      expect(out.alerts[0].pillar).toBe('ai');
      // The medium traffic alert is ordered after the high one.
      const severities = out.alerts.map((a) => a.severity);
      expect(severities.indexOf('high')).toBeLessThan(severities.indexOf('medium'));
   });

   it('breaks severity ties by the stable pillar order rank < traffic < ai < conversions', () => {
      // Two HIGH alerts: a rank page-one drop and a conversions drop. Rank must sort first.
      const current = quietPeriod({
         keywords: [kw('masset', 12)], // was 4 -> off page one -> high rank
         formSubmissions: 5, // -50% -> high conversions
      });
      const prior = quietPeriod({
         keywords: [kw('masset', 4)],
         formSubmissions: 10,
      });
      const out = detectChanges(current, prior);
      const highs = out.alerts.filter((a) => a.severity === 'high');
      expect(highs.length).toBeGreaterThanOrEqual(2);
      expect(highs[0].pillar).toBe('rank');
      const pillarsInOrder = out.alerts.filter((a) => a.severity === 'high').map((a) => a.pillar);
      expect(pillarsInOrder.indexOf('rank')).toBeLessThan(pillarsInOrder.indexOf('conversions'));
   });

   it('derives topPriority from the top alert (its headline + recommendation)', () => {
      const { current, prior } = pair(
         { keywords: [kw('DAM MCP server', 11, '/software/mcp')] }, // high rank drop
         { keywords: [kw('DAM MCP server', 4, '/software/mcp')] },
      );
      const out = detectChanges(current, prior);
      expect(out.topPriority).not.toBeNull();
      const top = out.alerts[0];
      expect(out.topPriority).toBe(`${top.headline} ${top.recommendation}`);
   });
});
