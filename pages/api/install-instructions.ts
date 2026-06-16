/**
 * On-demand install instructions for a domain's tracking code.
 *
 * Returns the Umami tracking snippet and per-platform install guides (raw HTML, Google Tag
 * Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React) for an already
 * onboarded domain, without re-running the whole onboard flow. Resolves the per-domain
 * Umami website id from Domain.umami_website_id, falling back to the UMAMI_WEBSITE_ID env so
 * the legacy single-tenant domain (getmasset.com) still returns a usable snippet.
 *
 * Multi-tenant: scoped via authorize + scopeWhere, matching pages/api/scoreboard.ts. With
 * MULTI_TENANT off the domain is matched by name exactly as today.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import { getInstallGuides, InstallGuides } from '../../utils/install-guides';

type InstallInstructionsResponse = {
   domain?: string,
   umamiWebsiteId?: string | null,
   installSnippet?: string,
   installGuides?: InstallGuides,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<InstallInstructionsResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getInstructions(req, res, account);
}

const getInstructions = async (
   req: NextApiRequest,
   res: NextApiResponse<InstallInstructionsResponse>,
   account?: Account | null,
) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = String(req.query.domain)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');

   try {
      // Verify the caller owns the domain before exposing its install details.
      const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }
      // Per-domain id first, then the legacy env fallback so getmasset.com still works.
      const umamiWebsiteId = owned.umami_website_id
         ? String(owned.umami_website_id)
         : (process.env.UMAMI_WEBSITE_ID || null);
      const installGuides = getInstallGuides(domain, umamiWebsiteId || '');
      return res.status(200).json({
         domain,
         umamiWebsiteId,
         installSnippet: installGuides.snippet,
         installGuides,
      });
   } catch (error) {
      console.log('[ERROR] Getting install instructions for ', domain, error);
      return res.status(400).json({ error: 'Error getting install instructions for this domain.' });
   }
};
