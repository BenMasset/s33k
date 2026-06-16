import type { NextApiRequest, NextApiResponse } from 'next';
import Domain from '../../database/models/domain';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import { crawlSite, SiteCrawlResult } from '../../utils/site-crawl';

type DiscoverResponse = SiteCrawlResult | { error: string };

/**
 * GET /api/discover?domain=getmasset.com
 *
 * Reads a domain's important pages (sitemap-first, homepage-link fallback) and
 * returns a compact per-page summary (title, meta description, h1/h2 headings,
 * and a short text excerpt). Powers the "just type your domain" onboarding: the
 * caller's own LLM reads these summaries and proposes target keywords, then adds
 * them with the add_keyword tool. No server-side LLM key is used.
 *
 * Bearer-API-key reachable (whitelisted in utils/verifyUser.ts) so the product
 * stays fully MCP-controllable.
 * @param {NextApiRequest} req - The Next request.
 * @param {NextApiResponse} res - The Next response.
 * @returns {Promise<void>}
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse<DiscoverResponse>) {
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }

   const domain = req.query.domain as string;
   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const result = await crawlSite(domain);
      return res.status(200).json(result);
   } catch (err) {
      console.log('[ERROR] Discovering pages for ', domain, err);
      return res.status(400).json({ error: 'Error discovering pages for this Domain.' });
   }
}
