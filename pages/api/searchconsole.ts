import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import {
   fetchDomainSCData,
   getSearchConsoleApiInfo,
   readLocalSCData,
   hasSearchConsoleCredentials,
   getSearchConsoleConnectionStatus,
   clearSearchConsoleOAuthToken,
   SCConnectionStatus,
} from '../../utils/searchConsole';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import { canonicalizeDomain } from '../../utils/canonical-domain';
import type Account from '../../database/models/account';

type searchConsoleRes = {
   data: SCDomainDataType|null
   status?: SCConnectionStatus,
   error?: string|null,
}

type searchConsoleCRONRes = {
   status: string,
   error?: string|null,
}

type searchConsoleDisconnectRes = {
   disconnected: boolean,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomainSearchConsoleData(req, res, account);
   }
   if (req.method === 'POST') {
      return cronRefreshSearchConsoleData(req, res, account);
   }
   if (req.method === 'DELETE') {
      return disconnectSearchConsole(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const getDomainSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') return res.status(400).json({ data: null, error: 'Domain is Missing.' });
   // Canonical-first resolution: look up the SAME canonical string the authorize() share-key gate
   // checked, then fall back to the legacy slug-decode only when canonical matched nothing. This is
   // the fix for the normalization-mismatch escape (a scoped key for "a-b.com" that decoded into the
   // sibling "a.b.com"); see utils/canonical-domain.ts. The slug-decode runs only when the canonical
   // form did not resolve, so it can never reach a domain the canonical form already owns.
   const canonicalDomain = canonicalizeDomain(req.query.domain);
   const slugDecodedDomain = (req.query.domain as string).replaceAll('-', '.').replaceAll('_', '-');
   let foundDomain: Domain | null = canonicalDomain ? await resolveDomainAccess(account, canonicalDomain) : null;
   if (!foundDomain && slugDecodedDomain !== canonicalDomain) {
      foundDomain = await resolveDomainAccess(account, slugDecodedDomain);
   }
   if (!foundDomain) {
      return res.status(403).json({ data: null, error: 'Domain not found for this account' });
   }
   const domainObj: DomainType = foundDomain.get({ plain: true });
   // Drive downstream SC-file reads/logs off the resolved row's domain, not the request string.
   const domainname = foundDomain.domain;
   // Surface connection state (oauth | service-account | null) alongside the data so a caller can
   // tell whether/how GSC is connected for this domain without ever seeing the credentials.
   const status = await getSearchConsoleConnectionStatus(domainObj);
   const localSCData = await readLocalSCData(domainname);
   if (localSCData && localSCData.thirtyDays && localSCData.thirtyDays.length) {
      return res.status(200).json({ data: localSCData, status });
   }
   try {
      const scDomainAPI = await getSearchConsoleApiInfo(domainObj);
      if (!hasSearchConsoleCredentials(scDomainAPI)) {
         return res.status(200).json({ data: null, status, error: 'Google Search Console is not Integrated.' });
      }
      const scData = await fetchDomainSCData(domainObj, scDomainAPI);
      return res.status(200).json({ data: scData, status });
   } catch (error) {
      console.log('[ERROR] Getting Search Console Data for: ', domainname, error);
      return res.status(400).json({ data: null, status, error: 'Error Fetching Data from Google Search Console.' });
   }
};

// DELETE /api/searchconsole?domain=<d>. Owner-gated disconnect: clears the click-to-authorize OAuth
// refresh token for the domain (service-account credentials, if any, stay as the fallback). Requires
// WRITE access to the domain, so a shared viewer (M2) or a foreign tenant can never disconnect it.
const disconnectSearchConsole = async (req: NextApiRequest, res: NextApiResponse<searchConsoleDisconnectRes>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') return res.status(400).json({ disconnected: false, error: 'Domain is Missing.' });
   // Same canonical-first resolution as the GET path, for consistency and defense-in-depth: resolve
   // the row by the canonical domain first, then the legacy slug-decode only as a fallback, and clear
   // the token off the RESOLVED row's actual domain. (Scoped share keys are GET-only and can never
   // reach this DELETE, but the route still must not slug-decode past its own write gate.)
   const canonicalDomain = canonicalizeDomain(req.query.domain);
   const slugDecodedDomain = (req.query.domain as string).replaceAll('-', '.').replaceAll('_', '-');
   let ownedDomain = canonicalDomain ? await resolveDomainAccess(account, canonicalDomain, { write: true }) : null;
   if (!ownedDomain && slugDecodedDomain !== canonicalDomain) {
      ownedDomain = await resolveDomainAccess(account, slugDecodedDomain, { write: true });
   }
   if (!ownedDomain) {
      return res.status(403).json({ disconnected: false, error: 'Domain not found for this account' });
   }
   const domainname = ownedDomain.domain;
   // Scope the clear to the exact owned row (its globally-unique domain name plus the owner scope),
   // so the write can only ever touch the caller's own domain.
   const cleared = await clearSearchConsoleOAuthToken({ domain: domainname, ...scopeWhere(account) });
   if (!cleared) {
      return res.status(400).json({ disconnected: false, error: 'Failed to disconnect Google Search Console.' });
   }
   return res.status(200).json({ disconnected: true });
};

const cronRefreshSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleCRONRes>, account?: Account | null) => {
   try {
      const allDomainsRaw = await Domain.findAll({ where: { ...scopeWhere(account) } });
      const Domains: DomainType[] = allDomainsRaw.map((el) => el.get({ plain: true }));
      for (const domain of Domains) {
         const scDomainAPI = await getSearchConsoleApiInfo(domain);
         if (scDomainAPI.client_email && scDomainAPI.private_key) {
            await fetchDomainSCData(domain, scDomainAPI);
         }
      }
      return res.status(200).json({ status: 'completed' });
   } catch (error) {
      console.log('[ERROR] CRON Updating Search Console Data. ', error);
      return res.status(400).json({ status: 'failed', error: 'Error Fetching Data from Google Search Console.' });
   }
};
