/**
 * Guards for the PUBLIC POST /api/collect ingest endpoint.
 *
 * /api/collect is the one s33k route that takes no API key: it is posted to directly by the
 * s33k.js script on a customer's website, so it cannot carry a secret. That makes it the most
 * abuse-exposed surface in the app. These helpers keep it cheap and safe:
 *   - isLikelyBotUA: drop obvious bot / crawler user-agents so autocapture stays human.
 *   - clientIp: best-effort caller IP from proxy headers for rate-limiting.
 *   - rateLimitCollect: a small in-memory, per-(ip+domain) sliding-window limiter so one
 *     source cannot flood the table. In-memory is intentional: the limiter is a coarse abuse
 *     brake, not an accounting system, and resets per server instance are acceptable.
 *
 * Nothing here throws.
 */

import { classifyCrawler } from './ai-crawlers';

/**
 * Generic non-browser / bot user-agent substrings, on top of the known AI/search crawlers in
 * ai-crawlers.ts. These are tools and libraries that should never be generating real
 * engagement events. Matched case-insensitively as substrings.
 */
const GENERIC_BOT_HINTS: readonly string[] = [
   'bot', 'spider', 'crawler', 'slurp', 'curl', 'wget', 'python-requests',
   'httpclient', 'okhttp', 'java/', 'go-http-client', 'libwww', 'headless',
   'phantomjs', 'puppeteer', 'playwright', 'scrapy', 'axios/', 'node-fetch',
];

/**
 * Whether a user-agent is a likely bot and its events should be dropped.
 * A missing/empty UA is treated as a bot: a real browser always sends one.
 * @param {string | undefined} userAgent - The raw User-Agent header.
 * @returns {boolean}
 */
export const isLikelyBotUA = (userAgent: string | undefined): boolean => {
   const ua = String(userAgent || '').toLowerCase().trim();
   if (!ua) { return true; }
   if (classifyCrawler(ua).isCrawler) { return true; }
   return GENERIC_BOT_HINTS.some((hint) => ua.includes(hint));
};

/**
 * Best-effort client IP from common proxy headers, falling back to the socket address.
 * Used only as a rate-limit key; it is never stored on an event row.
 * @param {Record<string, string | string[] | undefined>} headers - Request headers.
 * @param {string | undefined} socketRemote - req.socket.remoteAddress.
 * @returns {string}
 */
export const clientIp = (
   headers: Record<string, string | string[] | undefined>,
   socketRemote?: string,
): string => {
   const fwd = headers['x-forwarded-for'];
   const first = Array.isArray(fwd) ? fwd[0] : fwd;
   if (typeof first === 'string' && first.trim()) {
      return first.split(',')[0].trim();
   }
   const real = headers['x-real-ip'];
   if (typeof real === 'string' && real.trim()) { return real.trim(); }
   return socketRemote || 'unknown';
};

// In-memory sliding-window counters keyed by `${ip}:${domain}`. Each entry holds the start of
// the current window and the count within it. This is per-process and intentionally simple.
type Window = { windowStart: number, count: number };
const windows = new Map<string, Window>();

// Defaults: at most MAX_EVENTS event-rows accepted per key per WINDOW_MS. Generous enough for
// a busy page (batches of up to 50 every ~30s) but a hard brake on flooding.
export const COLLECT_WINDOW_MS = 60 * 1000;
export const COLLECT_MAX_EVENTS = 600;

// Cap the map size so a flood of unique keys cannot grow memory without bound.
const MAX_KEYS = 50000;

/**
 * Account `count` events against the (ip+domain) window. Returns whether they are allowed.
 * When a window expires it resets. Never throws.
 * @param {string} ip - The caller IP (rate-limit key part).
 * @param {string} domain - The target domain (rate-limit key part).
 * @param {number} count - Number of event-rows this request wants to add.
 * @param {number} [now] - Current epoch ms (injectable for tests).
 * @returns {boolean} True if allowed, false if the window is exhausted.
 */
export const rateLimitCollect = (ip: string, domain: string, count: number, now = Date.now()): boolean => {
   const key = `${ip}:${domain}`;
   const existing = windows.get(key);

   if (!existing || (now - existing.windowStart) >= COLLECT_WINDOW_MS) {
      // New or expired window. Opportunistically evict if the map is too large.
      if (windows.size > MAX_KEYS) { windows.clear(); }
      windows.set(key, { windowStart: now, count: Math.max(0, count) });
      return count <= COLLECT_MAX_EVENTS;
   }

   if (existing.count + count > COLLECT_MAX_EVENTS) {
      return false;
   }
   existing.count += count;
   return true;
};

/** Test-only: clear the in-memory rate-limit state. */
export const __resetRateLimit = (): void => { windows.clear(); };
