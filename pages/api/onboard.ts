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
import { firecrawlConfigured, extractKeywords } from '../../utils/firecrawl';
import { gradeKeywords } from '../../utils/keyword-grader';
import { createUmamiWebsite } from '../../utils/umami-provision';
import { getInstallGuides, InstallGuides } from '../../utils/install-guides';
import { isAccountActive, resolveCaps } from '../../utils/plans';
import { reserveSite, CapExceeded } from '../../utils/caps-guard';
import { rateLimit } from '../../utils/rate-limit';
import { resolveBaseUrl } from '../../utils/baseUrl';
import { trialEndedMessage, planLimitMessage, payPathHint } from '../../utils/billing-copy';

// Local control-flow signal: the canonical domain is already registered by ANY account. Thrown from
// inside the reserveSite createFn so the check-and-insert stays atomic, then mapped to the existing
// "already registered" 400 by the caller. A dedicated class (not a string match) so it can never be
// confused with a real DB error.
class DomainAlreadyRegistered extends Error {
   constructor() {
      super('Domain already registered.');
      this.name = 'DomainAlreadyRegistered';
   }
}

// Default cap on how many recommended keywords are added during onboarding. 50 = the per-site
// keyword allowance, so a fresh single-site account gets a full starting set from one scrape and
// the user just says "yes". The actual add is still clamped to the account's REMAINING allowance
// (see the allowance check below) so re-onboarding or a multi-site account can never bust the cap
// and inflate SERP COGS. The user can prune or extend afterward.
const MAX_ONBOARD_KEYWORDS = 50;

// A friendly pointer, returned on every successful onboard, that the dashboard is now the place
// to start. A brand-new user (or someone a domain was just shared with) is told in plain language
// what to ask next, so they never face a blank slate after setup.
type FirstRunHint = { title: string, detail: string, nextTool: string };

type OnboardResponse = {
   domain?: string,
   businessName?: string,
   discoveredKeywords?: string[],
   addedKeywords?: KeywordType[],
   rankingsPending?: boolean,
   siteId?: string | null,
   analyticsReady?: boolean,
   installSnippet?: string,
   installGuides?: InstallGuides,
   firstRunHint?: FirstRunHint,
   nextStepMessage?: string,
   timingNote?: string | null,
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

   // PER-KEY WRITE BRAKE: onboarding is a cost-bearing write (it creates a domain, queues SERP
   // scrapes, and provisions analytics). Mirror the hosted-MCP per-key brake so one leaked/runaway
   // key cannot fan out unbounded onboards. Keyed by the resolved account id, so it is per-tenant
   // and the single-tenant / flag-off admin shares one (its own) bucket. 429 + Retry-After when hit.
   const brake = rateLimit(`write:${ownerIdFor(account) ?? 'admin'}`, { limit: 60, windowMs: 60000 });
   if (!brake.allowed) {
      res.setHeader('Retry-After', Math.ceil(brake.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many onboard requests. Please wait a moment and try again.' });
   }

   try {
      // 1. Create the domain if the caller does not already own it (scoped + owner-stamped).
      const owner_id = ownerIdFor(account);
      // Reuse the caller's existing domain through the same WRITE gate every other domain-mutating
      // route uses. M1 is owner-only; M2 can later widen read access without accidentally letting a
      // shared viewer onboard/provision/mutate the owner's domain.
      let domainRow: Domain | null = await resolveDomainAccess(account, domain, { write: true });
      if (!domainRow) {
         // SITE CAP (the COGS / billing protection, mirrors pages/api/keywords.ts addKeywords). Only
         // enforced when CREATING a NEW domain row; reusing an already-owned row is never capped. An
         // inactive (expired-trial / canceled / past_due) account is locked out of new sites with an
         // upgrade message; an active account is held to its plan's site count. resolveCaps returns the
         // very-high UNLIMITED caps when MULTI_TENANT is off / for the admin sentinel, so this is a
         // no-op in single-tenant (same as the keyword cap). scopeWhere is {} in that case too.
         //
         // ATOMICITY (TOCTOU fix): the site count + create now run UNDER A ROW LOCK on the account
         // inside one transaction via reserveSite, so two concurrent onboards cannot both read
         // existingSites = 0 and both create past a 1-site cap. The canonical-collision check and the
         // create both run INSIDE the same transaction (createFn(t)). The flag-off / admin path is a
         // lock-free passthrough (unlimited caps), identical to before. A DomainAlreadyRegistered
         // signal (the existing-elsewhere case) and CapExceeded are mapped to their existing copies
         // in the catch below, so the user-facing 400/403 messages are unchanged.
         try {
            domainRow = await reserveSite<Domain>(account, async (t) => {
               // Before creating, reject a canonical name already owned by ANY account (the column is
               // globally @Unique). Without this, a tenant onboarding a canonical-equal variant of an
               // existing domain would hit a raw unique-constraint 400; checking explicitly returns a
               // clean message and guarantees we never attempt a colliding insert. Run inside the
               // transaction so the check-and-insert is atomic too.
               const existingElsewhere = await Domain.findOne({ where: { domain }, ...(t ? { transaction: t } : {}) });
               if (existingElsewhere) { throw new DomainAlreadyRegistered(); }
               return Domain.create({
                  domain,
                  slug: domain.replaceAll('-', '_').replaceAll('.', '-').replaceAll('/', '-'),
                  lastUpdated: new Date().toJSON(),
                  added: new Date().toJSON(),
                  owner_id,
               }, t ? { transaction: t } : undefined);
            });
         } catch (capError) {
            if (capError instanceof DomainAlreadyRegistered) {
               return res.status(400).json({ error: 'This domain is already registered.' });
            }
            if (capError instanceof CapExceeded) {
               // Human-first wall copy + a one-click pay link (utils/billing-copy). A LOCKED account
               // (trial expired / inactive) gets the trial-ended message; an ACTIVE account at its paid
               // site limit gets the plan-limit message. Caps-guard logic above is untouched.
               const baseUrl = resolveBaseUrl(req);
               const message = !isAccountActive(account)
                  ? trialEndedMessage(account, baseUrl)
                  : planLimitMessage(
                     `You are tracking the most sites your plan allows (${capError.limit}; ${capError.existing} in use).`,
                     account,
                     baseUrl,
                  );
               return res.status(403).json({ error: message });
            }
            throw capError;
         }
      }

      // 2. Recommend candidate target keywords from a single scrape. PREFER Firecrawl: it scrapes the
      //    site and its LLM synthesizes the top keyword phrases from the business name, page titles,
      //    and pillar pages (the "just say yes" path, no manual typing). FALL BACK to the heuristic
      //    crawler when Firecrawl is unconfigured, errors, or times out, so onboarding never breaks.
      //    Either way, build a globally deduped list remembering each keyword's best target page so it
      //    joins to a target_page in the scoreboard. discoveryError carries whichever source's error.
      const seen = new Set<string>();
      const selected: { keyword: string, target_page: string }[] = [];
      let businessName = '';
      let discoveryError: string | undefined;
      let usedFirecrawl = false;

      if (firecrawlConfigured()) {
         const fc = await extractKeywords(domain);
         if (fc.keywords.length > 0) {
            usedFirecrawl = true;
            businessName = fc.businessName;
            // QUALITY GRADER (deterministic Rubric 1, no LLM/no API key): score Firecrawl's raw
            // candidates against the scraped pages and keep only the ones that earn tracking, ranked
            // best-first. This is what strips the nav/doc-chrome junk ("agents", "all guides") and keeps
            // the real commercial terms. We can only grade when we actually have scraped page content;
            // with no pages (scrape failed) we cannot judge relevance, so we use Firecrawl's order as-is.
            // If grading runs but NOTHING clears the gate (a thin/odd site), we still take the top-ranked
            // candidates rather than return nothing, so onboarding is never empty (the junk still sinks).
            let chosen: { keyword: string, targetPage: string }[] = fc.keywords;
            if (fc.pages && fc.pages.length > 0) {
               const graded = gradeKeywords(fc.keywords, fc.pages, { businessName: fc.businessName });
               const passers = graded.filter((g) => g.pass);
               const ranked = passers.length > 0 ? passers : graded;
               chosen = ranked.map((g) => ({ keyword: g.keyword, targetPage: g.targetPage }));
            }
            for (const rec of chosen) {
               const key = rec.keyword.toLowerCase();
               if (!seen.has(key)) {
                  seen.add(key);
                  selected.push({ keyword: rec.keyword, target_page: rec.targetPage || '/' });
               }
               if (selected.length >= MAX_ONBOARD_KEYWORDS) { break; }
            }
         } else {
            discoveryError = fc.error;
         }
      }

      if (!usedFirecrawl) {
         // Heuristic fallback (also the path when no Firecrawl key is set): crawl a few pages and
         // derive candidates from on-page signals. Crawl failures surface as a note, never abort.
         const discovery = await discoverKeywords(domain);
         if (discovery.error) { discoveryError = discovery.error; }
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
      }

      // COGS guard: clamp the additions to the account's REMAINING keyword allowance so onboarding (or
      // a re-onboard, or a multi-site account) can never push total tracked keywords past the paid cap
      // and inflate the weekly SERP spend. resolveCaps returns the very-high UNLIMITED cap when
      // MULTI_TENANT is off / for the admin sentinel, so this is a no-op in single-tenant. The existing
      // count is scoped to the caller's own rows (scopeWhere), so one tenant's usage never reads another's.
      const existingKeywordCount = await Keyword.count({ where: { ...scopeWhere(account) } });
      const remainingAllowance = Math.max(0, resolveCaps(account).keywords - existingKeywordCount);
      const toAddSelected = selected.slice(0, remainingAllowance);

      // 3. Add the selected keywords exactly like pages/api/keywords.ts addKeywords does,
      //    then queue the background SERP scrape (rankings appear shortly).
      let addedKeywords: KeywordType[] = [];
      // rankingsPending answers "is a first Google rank check actually coming?". It is true only when
      // we both added keywords AND a SERP source is configured to check them. If no scraper is wired,
      // the keywords are still tracked but no live position will ever land, so this stays false and a
      // note explains why (a flat "checking now" would be a false promise).
      let rankingsPending = false;
      let scraperNote: string | null = null;
      let emptyKeywordsNote: string | null = null;
      let capNote: string | null = null;
      if (toAddSelected.length > 0) {
         const keywordsToAdd: any = toAddSelected.map((item) => ({
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
         // Is a SERP source actually configured? getAppSettings already folds the env fallbacks
         // (SCRAPER_TYPE, SERPER_API_KEY / SCAPING_API) into scraper_type / scaping_api, so checking
         // the resolved settings here covers both the UI-configured and the env-configured instance.
         const scraperConfigured = Boolean(settings.scraper_type && settings.scraper_type !== 'none' && settings.scaping_api);
         // Fire-and-forget background scrape, same as addKeywords (do not await).
         refreshAndUpdateKeywords(newKeywords, settings);
         if (scraperConfigured) {
            rankingsPending = true;
         } else {
            scraperNote = 'Rank tracking is not configured on this instance yet, so live Google positions will not appear '
               + 'until a SERP source is connected.';
         }
      } else if (selected.length > 0) {
         // We DID recommend keywords, but the account's keyword allowance is already full (a re-onboard,
         // or a multi-site account at its cap), so the COGS guard clamped the add to zero. Say so and
         // point at the fix, rather than the misleading "could not detect keywords" message below.
         capNote = 'Your plan\'s keyword allowance is full, so no new keywords were added. Remove some keywords to '
            + `make room, or add a site to track more.${payPathHint(account, resolveBaseUrl(req))}`;
      } else if (!discoveryError) {
         // Discovery succeeded but produced no candidate keywords (a JS-rendered or sparse site, or a
         // site Firecrawl could not analyze). Tell the user plainly and point them at the manual paths.
         emptyKeywordsNote = `We could not auto-detect keywords from ${domain} (the site may be sparse or unreachable). `
            + 'Add a few with add_keyword, or connect Google Search Console.';
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
            note = 'Analytics was not set up for this domain yet. '
               + 'The domain, keywords, and rankings are set up; re-run onboarding later to finish analytics setup.';
         }
      }

      // 5. Build the tracking snippet + per-platform install guides ONLY when analytics is ready.
      //    analyticsReady is false when no site id was provisioned (deferred or failed). A snippet
      //    with an empty website id cannot attribute a single pageview, so handing one out would just
      //    set the user up to "install" something that silently collects nothing. When it is not
      //    ready we omit the snippet/guides and explain why (start_here / install can gate on the flag).
      const analyticsReady = Boolean(siteId);
      const installGuides = analyticsReady ? getInstallGuides(domain, siteId as string) : undefined;
      const installSnippet = installGuides ? installGuides.snippet : undefined;
      if (!analyticsReady && !note) {
         note = 'Analytics is not set up for this domain yet, so there is no tracking snippet to install. '
            + 'Re-run onboarding once analytics provisioning is available, then add the snippet.';
      }

      // 6. Hand the user off to the dashboard so they never face a blank slate after setup.
      const firstRunHint: FirstRunHint = {
         title: 'See your dashboard',
         detail: `${domain} is set up. Ask "show me my dashboard" or "show me an overview" to see everything in one place, `
            + 'and you can always ask plain-language questions like "what should I do next?" or "how is my SEO?".',
         nextTool: 'dashboard',
      };
      const nextStepMessage = analyticsReady
         ? `${domain} is onboarded. Install the tracking snippet, then ask "show me my dashboard" for the full overview. `
            + 'You can ask plain-language questions any time.'
         : `${domain} is onboarded. Ask "show me my dashboard" for the full overview, and ask plain-language questions any time.`;

      // A first Google rank check is queued in the background only when we actually have a pending
      // scrape. Tell the user when to look again rather than letting them stare at empty rankings.
      const timingNote = rankingsPending
         ? 'First Google rank check runs in the background now; re-check with list_keywords or start_here shortly. '
            + 'Rankings refresh weekly after.'
         : null;

      // Combine ALL warnings rather than letting one silently win (note-precedence fix). The discovery
      // error (Firecrawl or crawl failed), the analytics-not-provisioned note, the no-scraper note, the
      // cap-full note, and the empty-keywords note can each be independently true; join the ones that
      // fired so none is lost. discoveryError is only surfaced when it actually blocked keyword adds (we
      // added nothing), so a Firecrawl miss that silently fell back to a working heuristic stays quiet.
      const discoveryNote = (toAddSelected.length === 0 && discoveryError) ? discoveryError : null;
      const notes = [note, discoveryNote, scraperNote, capNote, emptyKeywordsNote].filter(Boolean);

      return res.status(201).json({
         domain,
         businessName: businessName || undefined,
         discoveredKeywords: toAddSelected.map((item) => item.keyword),
         addedKeywords,
         rankingsPending,
         siteId,
         analyticsReady,
         installSnippet,
         installGuides,
         firstRunHint,
         nextStepMessage,
         timingNote,
         note: notes.length ? notes.join(' ') : null,
      });
   } catch (error) {
      console.log('[ERROR] Onboarding domain ', domain, error);
      return res.status(400).json({ error: 'Error onboarding this domain.' });
   }
};
