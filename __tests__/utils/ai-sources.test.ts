import { classifyReferrer, safeUpstreamDetail } from '../../utils/ai-sources';

describe('classifyReferrer', () => {
   it('maps known AI hosts to the right engine', () => {
      expect(classifyReferrer('chatgpt.com')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('chat.openai.com')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('www.perplexity.ai')).toEqual({ isAI: true, engine: 'Perplexity' });
      expect(classifyReferrer('gemini.google.com')).toEqual({ isAI: true, engine: 'Gemini' });
      expect(classifyReferrer('claude.ai')).toEqual({ isAI: true, engine: 'Claude' });
      expect(classifyReferrer('copilot.microsoft.com')).toEqual({ isAI: true, engine: 'Copilot' });
      expect(classifyReferrer('you.com')).toEqual({ isAI: true, engine: 'You.com' });
      expect(classifyReferrer('poe.com')).toEqual({ isAI: true, engine: 'Poe' });
      expect(classifyReferrer('deepseek.com')).toEqual({ isAI: true, engine: 'DeepSeek' });
      expect(classifyReferrer('grok.com')).toEqual({ isAI: true, engine: 'Grok' });
   });

   it('classifies provider-supplied labels, case-insensitively', () => {
      expect(classifyReferrer('ChatGPT')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('CLAUDE')).toEqual({ isAI: true, engine: 'Claude' });
      expect(classifyReferrer('Perplexity')).toEqual({ isAI: true, engine: 'Perplexity' });
   });

   it('parses full URLs and matches host plus path patterns', () => {
      expect(classifyReferrer('https://www.perplexity.ai/search?q=foo'))
         .toEqual({ isAI: true, engine: 'Perplexity' });
      expect(classifyReferrer('https://chatgpt.com/')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('https://www.bing.com/chat')).toEqual({ isAI: true, engine: 'Copilot' });
   });

   it('returns isAI false for non-AI sources', () => {
      expect(classifyReferrer('google.com')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('linkedin.com')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('https://news.ycombinator.com/')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('Direct / None')).toEqual({ isAI: false, engine: null });
   });

   it('never throws on empty or bad input', () => {
      expect(classifyReferrer('')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('   ')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer(null as unknown as string)).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer(undefined as unknown as string)).toEqual({ isAI: false, engine: null });
   });
});

describe('safeUpstreamDetail', () => {
   it('strips an absolute backend URL (the collector-host leak vector)', () => {
      const out = safeUpstreamDetail('connect ECONNREFUSED https://umami-production-a400b.up.railway.app/api/auth/login');
      expect(out).not.toMatch(/umami-production-a400b\.up\.railway\.app/);
      expect(out).not.toMatch(/https?:\/\//);
      expect(out).toContain('[host]');
   });

   it('strips a bare hostname:port token', () => {
      const out = safeUpstreamDetail('getaddrinfo ENOTFOUND umami-production-a400b.up.railway.app:443');
      expect(out).not.toMatch(/umami-production/);
      expect(out).toContain('[host]');
   });

   it('strips a bare IPv4 literal, with or without a port (the structural gap the Tyler gate flagged)', () => {
      expect(safeUpstreamDetail('connect ECONNREFUSED 10.1.2.3:3000')).not.toMatch(/10\.1\.2\.3/);
      expect(safeUpstreamDetail('socket hang up at 172.17.0.2')).not.toMatch(/172\.17\.0\.2/);
      expect(safeUpstreamDetail('connect ECONNREFUSED 10.1.2.3:3000')).toContain('[host]');
   });

   it('never echoes a tracking website id', () => {
      const out = safeUpstreamDetail('bad request for data-website-id="04075da4-ea3b-4c25-be70-85ed1650a7d4"');
      expect(out).not.toMatch(/04075da4/);
   });

   it('caps length and never returns empty', () => {
      expect(safeUpstreamDetail('x'.repeat(500)).length).toBeLessThanOrEqual(163);
      expect(safeUpstreamDetail('')).toBe('upstream analytics request failed');
      expect(safeUpstreamDetail(null)).toBe('upstream analytics request failed');
   });
});
