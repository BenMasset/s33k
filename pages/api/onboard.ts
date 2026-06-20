/**
 * Guided onboarding orchestration for s33k.
 *
 * One call, one input (a domain), and s33k sets the whole site up:
 *   1. Create the domain (scoped/owner-stamped via the multi-tenant pattern), or reuse it
 *      if the caller already owns it.
 *   2. Discover candidate target keywords heuristically (no server-side LLM) by crawling a
 *      few of the domain's pages (utils/keyword-discovery -> utils/site-crawl, SSRF-guarded).
 *   3. Add up to a sane cap of those keywords (deduped, one target_page each) the same way
 *      pages/api/keywords.ts addKeywords does, which also queues the background SERP scrape
 *      via utils/refresh.ts (so rankings appear shortly: rankingsPending = true).
 *   4. Provision a per-domain Umami analytics website and stamp Domain.umami_website_id, so
 *      subsequent analytics reads resolve per-domain automatically (see utils/umami.ts).
 *   5. Return the install snippet + per-platform install guides for the tracking code.
 *
 * Degrades gracefully: if analytics provisioning fails, the domain, keywords, and rankings still
 * come back with siteId = null and a note. The endpoint never 500s the whole onboard
 * for an analytics-provisioning failure.
 *
 * Multi-tenant: follows the wired pattern in pages/api/domains.ts and pages/api/scoreboard.ts
 * (authorize -> scopeWhere/ownerIdFor). With MULTI_TENANT off everything behaves as today.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { getAppSettings } from './settings';
import { discoverKeywords } from '../../utils/keyword-discovery';
import { createUmamiWebsite } from '../../utils/umami-provision';
import { getInstallGuides, InstallGuides } from '../../utils/install-guides';

// Default cap on how many discovered keywords are added during onboarding. Keeps the
// starting set focused and bounds the per-onboard SERP cost. The user can prune or extend.
const MAX_ONBOARD_KEYWORDS = 20;

// A friendly pointer, returned on every successful onboard, that the dashboard is now the place
// to start. A brand-new user (or someone a domain was just shared with) is told in plain language
// what to ask next, so they never face a blank slate after setup.
type FirstRunHint = { title: string, detail: string, nextTool: string };

type OnboardResponse = {
   domain?: string,
   discoveredKeywords?: string[],
   addedKeywords?: KeywordType[],
   rankingsPending?: boolean,
   siteId?: string | null,
   installSnippet?: string,
   installGuides?: InstallGuides,
   firstRunHint?: FirstRunHint,
   nextStepMessage?: string,
   note?: string | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<OnboardResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   return onboardDomain(req, res, account);
}

const onboardDomain = async (req: NextApiRequest, res: NextApiResponse<OnboardResponse>, account?: Account | null) => {
   // Canonicalize the domain ONCE, up front, and use that single canonical form for the find, the
   // create, and every downstream step (third adversarial review). Storing canonical is what keeps a
   // canonical-colliding sibling ("getmasset.com." vs "getmasset.com") from ever becoming a second
   // row under a different owner, which is the cross-tenant-leak precondition. canonicalizeDomain is
   // identity-preserving (lowercase, strip scheme/www/path/trailing-dot, never slug-decode).
   const domain = canonicalizeDomain(req.body?.domain);
   if (!domain) {
      return res.status(400).json({ error: 'A domain is required, e.g. "getmasset.com".' });
   }

   try {
      // 1. Create the domain if the caller does not already own it (scoped + owner-stamped).
      const owner_id = ownerIdFor(account);
      // Reuse the caller's existing domain through the same WRITE gate every other domain-mutating
      // route uses. M1 is owner-only; M2 can later widen read access without accidentally letting a
      // shared viewer onboard/provision/mutate the owner's domain.
      let domainRow: Domain | null = await resolveDomainAccess(account, domain, { write: true });
      if (!domainRow) {
         // Before creating, reject a canonical name already owned by ANY account (the column is
         // globally @Unique). Without this, a tenant onboarding a canonical-equal variant of an
         // existing domain would hit a raw unique-constraint 400; checking explicitly returns a
         // clean message and guarantees we never attempt a colliding insert.
         const existingElsewhere = await Domain.findOne({ where: { domain } });
         if (existingElsewhere) {
            return res.status(400).json({ error: 'This domain is already registered.' });
         }
         domainRow = await Domain.create({
            domain,
            slug: domain.replaceAll('-', '_').replaceAll('.', '-').replaceAll('/', '-'),
            lastUpdated: new Date().toJSON(),
            added: new Date().toJSON(),
            owner_id,
         });
      }

      // 2. Heuristically discover candidate target keywords per page (no LLM). Crawl
      //    failures surface as a discovery error but never abort onboarding.
      const discovery = await discoverKeywords(domain);

      // Flatten per-page candidates into a globally deduped, capped list while remembering
      // which page each keyword came from so it joins to a target_page in the scoreboard.
      const seen = new Set<string>();
      const selected: { keyword: string, target_page: string }[] = [];
      for (const candidate of discovery.candidates) {
         let targetPath = '';
         try { targetPath = new URL(candidate.page).pathname || '/'; } catch { targetPath = ''; }
         for (const keyword of candidate.suggestedKeywords) {
            const key = keyword.toLowerCase();
            if (!seen.has(key)) {
               seen.add(key);
               selected.push({ keyword, target_page: targetPath });
            }
            if (selected.length >= MAX_ONBOARD_KEYWORDS) { break; }
         }
         if (selected.length >= MAX_ONBOARD_KEYWORDS) { break; }
      }

      // 3. Add the selected keywords exactly like pages/api/keywords.ts addKeywords does,
      //    then queue the background SERP scrape (rankings appear shortly).
      let addedKeywords: KeywordType[] = [];
      if (selected.length > 0) {
         const keywordsToAdd: any = selected.map((item) => ({
            keyword: item.keyword,
            device: 'desktop',
            domain,
            country: 'US',
            city: '',
            target_page: item.target_page,
            position: 0,
            updating: true,
            history: JSON.stringify({}),
            url: '',
            tags: JSON.stringify([]),
            sticky: false,
            lastUpdated: new Date().toJSON(),
            added: new Date().toJSON(),
            owner_id,
         }));
         const newKeywords: Keyword[] = await Keyword.bulkCreate(keywordsToAdd);
         addedKeywords = parseKeywords(newKeywords.map((el) => el.get({ plain: true })));
         const settings = await getAppSettings();
         // Fire-and-forget background scrape, same as addKeywords (do not await).
         refreshAndUpdateKeywords(newKeywords, settings);
      }

      // 4. Provision a per-domain analytics site and stamp the id. Degrade gracefully.
      let siteId: string | null = null;
      let note: string | null = null;
      if (domainRow.umami_website_id) {
         siteId = String(domainRow.umami_website_id);
      } else {
         const provisioned = await createUmamiWebsite(domain);
         if (provisioned.websiteId) {
            siteId = provisioned.websiteId;
            await domainRow.update({ umami_website_id: siteId });
         } else {
            note = `Analytics website was not provisioned: ${provisioned.error || 'unknown error'}. `
               + 'The domain, keywords, and rankings are set up; add analytics later by re-running onboarding once Umami is reachable.';
         }
      }

      // 5. Build the tracking snippet + per-platform install guides (empty id is allowed,
      //    so the customer still sees the shape even if provisioning was deferred).
      const installGuides = getInstallGuides(domain, siteId || '');

      // 6. Hand the user off to the dashboard so they never face a blank slate after setup.
      const firstRunHint: FirstRunHint = {
         title: 'See your dashboard',
         detail: `${domain} is set up. Ask "show me my dashboard" or "show me an overview" to see everything in one place, `
            + 'and you can always ask plain-language questions like "what should I do next?" or "how is my SEO?".',
         nextTool: 'dashboard',
      };
      const nextStepMessage = `${domain} is onboarded. Install the tracking snippet, then ask "show me my dashboard" for the full overview. `
         + 'You can ask plain-language questions any time.';

      return res.status(201).json({
         domain,
         discoveredKeywords: selected.map((item) => item.keyword),
         addedKeywords,
         rankingsPending: addedKeywords.length > 0,
         siteId,
         installSnippet: installGuides.snippet,
         installGuides,
         firstRunHint,
         nextStepMessage,
         note: note || discovery.error || null,
      });
   } catch (error) {
      console.log('[ERROR] Onboarding domain ', domain, error);
      return res.status(400).json({ error: 'Error onboarding this domain.' });
   }
};
