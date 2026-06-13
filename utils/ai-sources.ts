/**
 * AI-referrer classifier.
 *
 * Phase 4 of s33k reframes "AEO" as AI REFERRAL TRACKING: which AI engines
 * (ChatGPT, Perplexity, Gemini, Claude, Copilot, etc.) are actually sending
 * real visitors to the site. That signal comes from analytics REFERRAL data,
 * never from querying an LLM.
 *
 * This module owns the one job of deciding, for a given referral source string
 * (a hostname, a full URL, or a provider-supplied label like "ChatGPT"),
 * whether it is an AI engine and, if so, which one. Both analytics providers
 * use it:
 *   - Umami reports raw referrer hosts and does NOT tag AI; it relies entirely
 *     on this classifier.
 *   - Lodd already tags AI referrers (source_type === "ai") and puts the engine
 *     in source_name; this classifier is still run to normalize that name to a
 *     consistent engine label.
 *
 * To add or adjust an engine, edit the AI_ENGINES array below. Each entry maps
 * one normalized engine label to the list of case-insensitive substrings that
 * identify it in a host or name. Order matters only in that the first matching
 * engine wins, so keep more-specific patterns ahead of broader ones.
 */

/** One AI engine and the host/name substrings that identify it (case-insensitive). */
export type AiEnginePattern = {
   /** The normalized, user-facing engine label, e.g. "ChatGPT". */
   engine: string,
   /** Substrings to match against the referrer host or name (lowercased). */
   match: string[],
}

/**
 * The editable AI-engine list. Add a row to track a new engine; extend `match`
 * to catch a new host or label for an existing engine. Patterns are matched as
 * case-insensitive substrings against the cleaned source string.
 */
export const AI_ENGINES: AiEnginePattern[] = [
   { engine: 'ChatGPT', match: ['chatgpt', 'chat.openai.com', 'openai.com', 'oai.azure'] },
   { engine: 'Perplexity', match: ['perplexity'] },
   { engine: 'Gemini', match: ['gemini.google.com', 'gemini', 'bard.google.com', 'bard'] },
   { engine: 'Google AI Overviews', match: ['google ai overview', 'ai.google', 'aioverview'] },
   { engine: 'Claude', match: ['claude.ai', 'claude', 'anthropic'] },
   { engine: 'Copilot', match: ['copilot.microsoft.com', 'copilot', 'bingchat', 'bing.com/chat'] },
   { engine: 'You.com', match: ['you.com'] },
   { engine: 'Poe', match: ['poe.com', 'poe'] },
   { engine: 'Phind', match: ['phind'] },
   { engine: 'Meta AI', match: ['meta.ai'] },
   { engine: 'DeepSeek', match: ['deepseek'] },
   { engine: 'Grok', match: ['grok', 'x.ai'] },
];

/**
 * Reduce a referral source (host, full URL, or label) to a lowercase string
 * suitable for substring matching. If a full URL is passed, the host plus path
 * is kept so host-specific and path-specific patterns (e.g. "bing.com/chat")
 * both have a chance to match.
 * @param {string} source - Raw referral source.
 * @returns {string} A lowercased, trimmed match target.
 */
const normalizeSource = (source: string): string => {
   const raw = String(source || '').trim().toLowerCase();
   if (!raw) { return ''; }
   try {
      if (/^https?:\/\//i.test(raw)) {
         const u = new URL(raw);
         return `${u.host}${u.pathname}`.toLowerCase();
      }
   } catch {
      // Not a parseable URL; fall through and match the raw string.
   }
   return raw;
};

/**
 * Classify a referral source as an AI engine or not.
 *
 * Never throws. Matches case-insensitively against AI_ENGINES; the first engine
 * with any matching substring wins. Returns the normalized engine label when AI,
 * or { isAI: false, engine: null } otherwise.
 *
 * @param {string} source - A referrer hostname, full URL, or provider label
 *                          (e.g. "chatgpt.com", "https://www.perplexity.ai/", "Claude").
 * @returns {{ isAI: boolean, engine: string | null }}
 */
export const classifyReferrer = (source: string): { isAI: boolean, engine: string | null } => {
   const target = normalizeSource(source);
   if (!target) { return { isAI: false, engine: null }; }
   for (const entry of AI_ENGINES) {
      if (entry.match.some((needle) => target.includes(needle))) {
         return { isAI: true, engine: entry.engine };
      }
   }
   return { isAI: false, engine: null };
};

export default classifyReferrer;
