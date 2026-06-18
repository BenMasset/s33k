import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import { getCountryInsight, getKeywordsInsight, getPagesInsight } from '../../utils/insight';
import { fetchDomainSCData, getSearchConsoleApiInfo, readLocalSCData, hasSearchConsoleCredentials } from '../../utils/searchConsole';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import type Account from '../../database/models/account';
import Domain from '../../database/models/domain';

type SCInsightRes = {
   data: InsightDataType | null,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomainSearchConsoleInsight(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const getDomainSearchConsoleInsight = async (req: NextApiRequest, res: NextApiResponse<SCInsightRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') return res.status(400).json({ data: null, error: 'Domain is Missing.' });

   // Resolve access against the SAME canonical string the authorize() share-key gate checked, so the
   // gate and this lookup can never diverge. We try the CANONICAL raw domain FIRST; only if that
   // matches no row do we fall back to the legacy slug-decode ("-" -> ".", "_" -> "-") that the UI
   // still uses for some callers. Canonical-first is what closes the escape: a dashed domain that
   // actually exists resolves on the canonical path with NO decode, so a scoped key for "a-b.com"
   // can never be decoded into the sibling "a.b.com". The slug-decode only ever runs when the
   // canonical form did not exist, so it cannot reach a domain the canonical form already owns.
   const canonicalDomain = canonicalizeDomain(req.query.domain);
   const slugDecodedDomain = (req.query.domain as string).replaceAll('-', '.').replaceAll('_', '-');

   // Verify the caller may access this domain before reading any (possibly cached) Search
   // Console data for it. resolveDomainAccess is the per-domain chokepoint: admin /
   // MULTI_TENANT-off callers match any domain, a tenant only their own (M2: owned OR shared).
   // This guards the local-SC-file read below too.
   let ownedDomain: Domain | null = canonicalDomain ? await resolveDomainAccess(account, canonicalDomain) : null;
   if (!ownedDomain && slugDecodedDomain !== canonicalDomain) {
      ownedDomain = await resolveDomainAccess(account, slugDecodedDomain);
   }
   if (!ownedDomain) {
      return res.status(403).json({ data: null, error: 'Domain not found for this account' });
   }
   // Drive all downstream reads off the row we actually resolved, not the request string, so the
   // SC-file read and logs use the domain that passed the access check.
   const domainname = ownedDomain.domain;
   const getInsightFromSCData = (localSCData: SCDomainDataType): InsightDataType => {
      const { stats = [] } = localSCData;
      const countries = getCountryInsight(localSCData);
      const keywords = getKeywordsInsight(localSCData);
      const pages = getPagesInsight(localSCData);
      return { pages, keywords, countries, stats };
   };

   // First try and read the  Local SC Domain Data file.
   const localSCData = await readLocalSCData(domainname);

   if (localSCData) {
      const oldFetchedDate = localSCData.lastFetched;
      const fetchTimeDiff = new Date().getTime() - (oldFetchedDate ? new Date(oldFetchedDate as string).getTime() : 0);
      if (localSCData.stats && localSCData.stats.length && fetchTimeDiff <= 86400000) {
         const response = getInsightFromSCData(localSCData);
         return res.status(200).json({ data: response });
      }
   }

   // If the Local SC Domain Data file does not exist, fetch from Googel Search Console.
   try {
      const domainObj: DomainType = ownedDomain.get({ plain: true });
      const scDomainAPI = await getSearchConsoleApiInfo(domainObj);
      if (!hasSearchConsoleCredentials(scDomainAPI)) {
         return res.status(200).json({ data: null, error: 'Google Search Console is not Integrated.' });
      }
      const scData = await fetchDomainSCData(domainObj, scDomainAPI);
      const response = getInsightFromSCData(scData);
      return res.status(200).json({ data: response });
   } catch (error) {
      console.log('[ERROR] Getting Domain Insight: ', domainname, error);
      return res.status(400).json({ data: null, error: 'Error Fetching Stats from Google Search Console.' });
   }
};
