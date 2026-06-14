import {
   isBotSegment, splitHumanBot, isHumanReferrer, BOUNCE_MIN, DURATION_MAX, BotRow,
} from '../../utils/bot-filter';

describe('isBotSegment', () => {
   it('flags ~100% bounce with near-zero duration as bot', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 2 })).toBe(true);
      expect(isBotSegment({ bounce_rate: BOUNCE_MIN, avg_duration: DURATION_MAX - 0.1 })).toBe(true);
   });

   it('treats a null duration at high bounce as bot (single-hit bounce)', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: null })).toBe(true);
      expect(isBotSegment({ bounce_rate: 100 })).toBe(true);
   });

   it('does not flag when bounce is below the threshold', () => {
      expect(isBotSegment({ bounce_rate: 98, avg_duration: 1 })).toBe(false);
   });

   it('does not flag when duration is at/above the threshold', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: DURATION_MAX })).toBe(false);
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 60 })).toBe(false);
   });

   it('treats a missing bounce_rate as human (no behavioral evidence)', () => {
      expect(isBotSegment({ avg_duration: 1 })).toBe(false);
      expect(isBotSegment({ bounce_rate: null, avg_duration: 1 })).toBe(false);
   });

   it('honors the engaged human floor even at 100% bounce', () => {
      expect(isBotSegment({ bounce_rate: 100, avg_duration: 1, engaged: true })).toBe(false);
   });

   it('honors the known-human referrer floor even at 100% bounce', () => {
      expect(isBotSegment({ name: 'google', bounce_rate: 100, avg_duration: 1 })).toBe(false);
      expect(isBotSegment({ name: 'chatgpt.com', bounce_rate: 100, avg_duration: 0 })).toBe(false);
      expect(isBotSegment({ isAI: true, bounce_rate: 100, avg_duration: 0 })).toBe(false);
      expect(isBotSegment({ source_type: 'search', bounce_rate: 100, avg_duration: 0 })).toBe(false);
   });

   it('never throws on bad input', () => {
      expect(isBotSegment(null as unknown as BotRow)).toBe(false);
      expect(isBotSegment({ bounce_rate: NaN, avg_duration: NaN })).toBe(false);
   });
});

describe('isHumanReferrer', () => {
   it('matches AI flag, human source types, and name hints', () => {
      expect(isHumanReferrer({ isAI: true })).toBe(true);
      expect(isHumanReferrer({ source_type: 'social' })).toBe(true);
      expect(isHumanReferrer({ name: 'LinkedIn' })).toBe(true);
      expect(isHumanReferrer({ name: 'somerandomscraper.io' })).toBe(false);
      expect(isHumanReferrer({})).toBe(false);
   });
});

describe('splitHumanBot', () => {
   it('splits rows and sums unique_visitors on each side', () => {
      const rows: BotRow[] = [
         { name: 'HK', unique_visitors: 100, bounce_rate: 100, avg_duration: 1 }, // bot
         { name: 'SG', unique_visitors: 50, bounce_rate: 99.5, avg_duration: null }, // bot
         { name: 'US', unique_visitors: 40, bounce_rate: 60, avg_duration: 90 }, // human
         { name: 'google', unique_visitors: 10, bounce_rate: 100, avg_duration: 0 }, // human floor
      ];
      const split = splitHumanBot(rows);
      expect(split.botVisitors).toBe(150);
      expect(split.humanVisitors).toBe(50);
      expect(split.totalVisitors).toBe(200);
      expect(split.botSharePct).toBe(75);
      expect(split.bot).toHaveLength(2);
      expect(split.human).toHaveLength(2);
   });

   it('returns an all-zero split for empty or bad input', () => {
      const empty = splitHumanBot([]);
      expect(empty.botSharePct).toBe(0);
      expect(empty.totalVisitors).toBe(0);
      const bad = splitHumanBot(null as unknown as BotRow[]);
      expect(bad.botVisitors).toBe(0);
   });

   it('ignores negative or non-finite visitor counts', () => {
      const split = splitHumanBot([
         { unique_visitors: -5, bounce_rate: 100, avg_duration: 1 },
         { unique_visitors: 10, bounce_rate: 100, avg_duration: 1 },
      ]);
      expect(split.botVisitors).toBe(10);
   });
});
