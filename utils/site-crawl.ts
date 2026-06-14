/**
 * Lightweight, dependency-free site crawler for s33k onboarding.
 *
 * Given a domain, this discovers important page URLs (sitemap.xml first, then a
 * homepage-link fallback), fetches each page, and extracts a compact summary
 * (title, meta description, h1/h2 headings, and a short text excerpt).
 *
 * Design constraints:
 *   - Plain server-side fetch + regex-based HTML parsing. No paid API, no
 *     headless browser, no Firecrawl key.
 *   - Capped at MAX_PAGES pages so one onboarding call stays cheap.
 *   - Never throws. Every failure (DNS, timeout, non-HTML, parse error) is
 *     swallowed and surfaced as an "error" field on the affected item or on the
 *     top-level result, so the LLM always gets a usable answer.
 *
 * The output is meant to be handed to the user's own connected LLM (over MCP),
 * which reads the page summaries and proposes target keywords itself. s33k does
 * not run any server-side LLM here.
 */

/** Maximum number of pages summarized in a single crawl. */
export const MAX_PAGES = 25;

/** Per-request fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 10000;

/** A realistic, honest user agent so well-behaved sites do not block us. */
const USER_AGENT = 's33k-onboarding-crawler/0.1 (+https://github.com/s33k)';

export type PageSummary = {
   url: string,
   path: string,
   title: string,
   metaDescription: string,
   h1: string[],
   h2: string[],
   excerpt: string,
   error?: string,
};

export type SiteCrawlResult = {
   domain: string,
   homeUrl: string,
   discoveredVia: 'sitemap' | 'homepage-links' | 'homepage-only',
   pageCount: number,
   pages: PageSummary[],
   error?: string,
};

/**
 * Normalize a user-supplied domain into a clean hostname (no scheme, no path,
 * no trailing slash, lowercased).
 * @param {string} input - Raw domain or URL the caller passed.
 * @returns {string} A bare hostname, e.g. "getmasset.com".
 */
const normalizeDomain = (input: string): string => String(input || '')
   .trim()
   .toLowerCase()
   .replace(/^https?:\/\//, '')
   .replace(/^www\./, '')
   .replace(/\/.*$/, '')
   .replace(/\/$/, '');

/**
 * SSRF guard. Returns true when a hostname is safe to fetch (a public host) and
 * false when it targets loopback, private, link-local, or cloud-metadata space.
 *
 * This crawler fetches a caller-supplied domain server-side, so without this
 * guard a caller could point it at internal infrastructure (e.g. localhost, an
 * RFC1918 address, or the 169.254.169.254 cloud-metadata endpoint) and read the
 * response back. The product is moving to multi-tenant hosting where API keys are
 * held by untrusted tenants, so block those targets up front. The check is on the
 * literal hostname only (it does not resolve DNS), which blocks the obvious
 * literal-IP and localhost cases cheaply; DNS-rebind / redirect-to-internal is a
 * known residual the hosted deployment should additionally pin at the network
 * egress layer.
 * @param {string} hostname - The URL hostname (already lowercased by URL).
 * @returns {boolean} True if safe to fetch.
 */
const isPublicHostname = (hostname: string): boolean => {
   const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
   if (!host) { return false; }
   // Loopback / unspecified / local names.
   if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) { return false; }
   if (host === '0.0.0.0' || host === '::' || host === '::1') { return false; }
   // IPv4-literal ranges: loopback, RFC1918 private, link-local (incl. metadata),
   // and carrier-grade NAT.
   const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
   if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      if (a === 127 || a === 10 || a === 0) { return false; }
      if (a === 169 && b === 254) { return false; } // link-local + 169.254.169.254 metadata
      if (a === 172 && b >= 16 && b <= 31) { return false; }
      if (a === 192 && b === 168) { return false; }
      if (a === 100 && b >= 64 && b <= 127) { return false; } // CGNAT
   }
   // IPv6 private / loopback / unique-local / link-local literals.
   if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:127')) { return false; }
   return true;
};

/**
 * Fetch a URL as text with a timeout. Never throws; returns null on any failure
 * or non-2xx response. Refuses non-http(s) schemes and non-public hosts (SSRF
 * guard) before making any network call.
 * @param {string} url - Absolute URL to fetch.
 * @param {string} [accept] - Optional Accept header.
 * @returns {Promise<string | null>} The response body text, or null.
 */
const safeFetchText = async (url: string, accept?: string): Promise<string | null> => {
   let parsed: URL;
   try { parsed = new URL(url); } catch { return null; }
   if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return null; }
   if (!isPublicHostname(parsed.hostname)) { return null; }
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
   try {
      const res = await fetch(url, {
         headers: {
            'User-Agent': USER_AGENT,
            ...(accept ? { Accept: accept } : {}),
         },
         signal: controller.signal,
         redirect: 'follow',
      });
      if (!res.ok) { return null; }
      return await res.text();
   } catch {
      return null;
   } finally {
      clearTimeout(timer);
   }
};

/**
 * Strip HTML tags and collapse whitespace from a fragment of markup.
 * @param {string} html - Raw HTML.
 * @returns {string} Plain text, whitespace-collapsed.
 */
const stripTags = (html: string): string => html
   .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
   .replace(/<!--[\s\S]*?-->/g, ' ')
   .replace(/<[^>]+>/g, ' ')
   .replace(/&nbsp;/gi, ' ')
   .replace(/&amp;/gi, '&')
   .replace(/&lt;/gi, '<')
   .replace(/&gt;/gi, '>')
   .replace(/&quot;/gi, '"')
   .replace(/&#39;/gi, "'")
   .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; } })
   .replace(/&#(\d+);/g, (_m, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ' '; } })
   .replace(/\s+/g, ' ')
   .trim();

/**
 * Extract all loc URLs from a sitemap or sitemap-index XML body.
 * @param {string} xml - Raw sitemap XML.
 * @returns {string[]} The list of <loc> URLs found.
 */
const extractLocs = (xml: string): string[] => {
   const locs: string[] = [];
   const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
   let m = re.exec(xml);
   while (m) {
      locs.push(m[1].trim());
      m = re.exec(xml);
   }
   return locs;
};

/**
 * Discover page URLs for a domain via sitemap.xml, following one level of
 * sitemap-index nesting. Returns an empty array if no sitemap is reachable.
 * @param {string} origin - The https origin, e.g. "https://getmasset.com".
 * @returns {Promise<string[]>} Discovered absolute page URLs.
 */
const discoverFromSitemap = async (origin: string): Promise<string[]> => {
   const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
   for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const xml = await safeFetchText(candidate, 'application/xml,text/xml');
      if (!xml) { continue; }
      const locs = extractLocs(xml);
      if (locs.length === 0) { continue; }

      // If the sitemap points at other sitemaps (a sitemap index), pull the
      // first few child sitemaps and flatten their page URLs.
      const isIndex = /<sitemapindex/i.test(xml) || locs.some((l) => /\.xml(\?|$)/i.test(l));
      if (isIndex) {
         const pages: string[] = [];
         const childSitemaps = locs.filter((l) => /\.xml(\?|$)/i.test(l)).slice(0, 5);
         for (const child of childSitemaps) {
            // eslint-disable-next-line no-await-in-loop
            const childXml = await safeFetchText(child, 'application/xml,text/xml');
            if (childXml) { pages.push(...extractLocs(childXml).filter((l) => !/\.xml(\?|$)/i.test(l))); }
            if (pages.length >= MAX_PAGES * 2) { break; }
         }
         // Some indexes also list real pages directly; include those too.
         pages.push(...locs.filter((l) => !/\.xml(\?|$)/i.test(l)));
         if (pages.length > 0) { return pages; }
      }
      return locs.filter((l) => !/\.xml(\?|$)/i.test(l));
   }
   return [];
};

/**
 * Discover page URLs by scraping same-origin anchor hrefs from the homepage.
 * Used when no sitemap is available.
 * @param {string} origin - The https origin.
 * @param {string} homeHtml - The fetched homepage HTML.
 * @returns {string[]} Discovered absolute, same-origin page URLs.
 */
const discoverFromHomepage = (origin: string, homeHtml: string): string[] => {
   const host = origin.replace(/^https?:\/\//, '');
   const found = new Set<string>();
   const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
   let m = re.exec(homeHtml);
   while (m) {
      const raw = m[1].trim();
      let abs: string | null = null;
      try {
         if (raw.startsWith('http://') || raw.startsWith('https://')) {
            const u = new URL(raw);
            if (u.hostname.replace(/^www\./, '') === host.replace(/^www\./, '')) { abs = u.toString(); }
         } else if (raw.startsWith('/')) {
            abs = `${origin}${raw}`;
         }
      } catch {
         abs = null;
      }
      if (abs && !/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|xml|json|woff2?|ttf|mp4|webm)(\?|$)/i.test(abs)) {
         // Drop the fragment/query for de-duplication of the same page.
         found.add(abs.replace(/[?#].*$/, ''));
      }
      m = re.exec(homeHtml);
   }
   return Array.from(found);
};

/**
 * Extract a compact summary from a page's HTML.
 * @param {string} url - The absolute page URL.
 * @param {string} html - The fetched HTML body.
 * @returns {PageSummary} The structured summary.
 */
const summarizePage = (url: string, html: string): PageSummary => {
   let path = url;
   try { path = new URL(url).pathname || '/'; } catch { /* keep url */ }

   const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
   const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 300) : '';

   const descMatch = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(html)
      || /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i.exec(html);
   let metaDescription = '';
   if (descMatch) {
      const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(descMatch[0]);
      if (contentMatch) { metaDescription = stripTags(contentMatch[1]).slice(0, 500); }
   }

   const collectHeadings = (tag: 'h1' | 'h2'): string[] => {
      const out: string[] = [];
      const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      let hm = re.exec(html);
      while (hm && out.length < 10) {
         const text = stripTags(hm[1]);
         if (text) { out.push(text.slice(0, 200)); }
         hm = re.exec(html);
      }
      return out;
   };

   // Excerpt: prefer the <body> text, fall back to the whole doc.
   const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
   const excerpt = stripTags(bodyMatch ? bodyMatch[1] : html).slice(0, 600);

   return {
      url,
      path,
      title,
      metaDescription,
      h1: collectHeadings('h1'),
      h2: collectHeadings('h2'),
      excerpt,
   };
};

/**
 * Rank/prune discovered URLs to a tidy, representative set. Prefers shorter
 * paths (closer to the root, usually the important hub pages), drops obvious
 * non-content paths, de-duplicates, and caps the list.
 * @param {string[]} urls - Raw discovered URLs.
 * @param {string} homeUrl - The homepage URL, always kept first.
 * @returns {string[]} A pruned, ordered URL list.
 */
const prioritize = (urls: string[], homeUrl: string): string[] => {
   const seen = new Set<string>();
   const cleaned: string[] = [];
   const all = [homeUrl, ...urls];
   for (const u of all) {
      // Normalize away scheme, www., query/fragment, and trailing slash so that
      // homepage and host variants (e.g. "https://x.com/" vs "https://www.x.com")
      // collapse to one entry.
      const key = u
         .replace(/^https?:\/\//, '')
         .replace(/^www\./, '')
         .replace(/[?#].*$/, '')
         .replace(/\/$/, '') || u;
      if (seen.has(key)) { continue; }
      if (/\/(wp-admin|wp-json|cdn-cgi|feed|tag\/|category\/|author\/)/i.test(u)) { continue; }
      seen.add(key);
      cleaned.push(u);
   }
   const home = cleaned[0];
   const rest = cleaned.slice(1).sort((a, b) => {
      const depth = (s: string) => (s.replace(/^https?:\/\/[^/]+/, '').match(/\//g) || []).length;
      const da = depth(a);
      const db = depth(b);
      if (da !== db) { return da - db; }
      return a.length - b.length;
   });
   return [home, ...rest].slice(0, MAX_PAGES);
};

/**
 * Crawl a domain and return compact per-page summaries.
 *
 * Tries https first; discovers URLs via sitemap.xml, falling back to homepage
 * links, then to the homepage alone. Fetches each selected page and extracts a
 * summary. Never throws.
 * @param {string} domainInput - Raw domain or URL, e.g. "getmasset.com".
 * @returns {Promise<SiteCrawlResult>} The crawl result with page summaries.
 */
export async function crawlSite(domainInput: string): Promise<SiteCrawlResult> {
   const domain = normalizeDomain(domainInput);
   if (!domain) {
      return {
         domain: String(domainInput || ''),
         homeUrl: '',
         discoveredVia: 'homepage-only',
         pageCount: 0,
         pages: [],
         error: 'A valid domain is required.',
      };
   }

   const origin = `https://${domain}`;
   const homeUrl = `${origin}/`;

   const homeHtml = await safeFetchText(homeUrl, 'text/html');
   if (homeHtml === null) {
      return {
         domain,
         homeUrl,
         discoveredVia: 'homepage-only',
         pageCount: 0,
         pages: [],
         error: `Could not reach ${homeUrl}. The domain may be unreachable, blocking crawlers, or not served over https.`,
      };
   }

   let discoveredVia: SiteCrawlResult['discoveredVia'] = 'homepage-only';
   let urls = await discoverFromSitemap(origin);
   if (urls.length > 0) {
      discoveredVia = 'sitemap';
   } else {
      urls = discoverFromHomepage(origin, homeHtml);
      if (urls.length > 0) { discoveredVia = 'homepage-links'; }
   }

   const selected = prioritize(urls, homeUrl);

   // Fetch and summarize each selected page. The homepage HTML is already in
   // hand, so reuse it instead of re-fetching.
   const pages: PageSummary[] = [];
   for (const url of selected) {
      let html: string | null;
      if (url === homeUrl || url.replace(/\/$/, '') === homeUrl.replace(/\/$/, '')) {
         html = homeHtml;
      } else {
         // eslint-disable-next-line no-await-in-loop
         html = await safeFetchText(url, 'text/html');
      }
      if (html === null) {
         let path = url;
         try { path = new URL(url).pathname || '/'; } catch { /* keep url */ }
         pages.push({ url, path, title: '', metaDescription: '', h1: [], h2: [], excerpt: '', error: 'Could not fetch this page.' });
         continue;
      }
      pages.push(summarizePage(url, html));
   }

   return {
      domain,
      homeUrl,
      discoveredVia,
      pageCount: pages.length,
      pages,
   };
}
