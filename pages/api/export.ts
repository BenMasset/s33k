import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import CrawlerHit from '../../database/models/crawlerHit';
import S33kEvent from '../../database/models/s33kEvent';
import Account from '../../database/models/account';
import ApiKey from '../../database/models/apiKey';
import Invite from '../../database/models/invite';
import FeatureRequest from '../../database/models/featureRequest';
import authorize from '../../utils/authorize';
import { scopeWhere, ADMIN_ACCOUNT_ID } from '../../utils/scope';
import type Account2 from '../../database/models/account';

// DATA EXPORT: ownership the caller can exercise. GET /api/export returns EVERYTHING s33k
// holds for the calling account as one JSON bundle: domains, keywords (with full rank
// history), crawler hits, autocapture events, and account/key metadata. This is the
// human-and-machine-readable proof of "your data is yours and you can take it with you."
//
// TENANT-SCOPED: the bundle only ever contains the caller's own data. Every query is
// scoped with scopeWhere(account) (owner_id) and/or by the caller's owned domain names,
// so one account can never read another account's rows through this route. With
// MULTI_TENANT off, scopeWhere returns {} and the caller is the admin account, so the
// export is simply all data (single-tenant behavior, unchanged).
//
// NO SECRETS EVER LEAVE: this endpoint never emits a secret. Search Console / Google Ads
// credentials on a domain are cryptr-encrypted at rest (see utils/searchConsole.ts); we
// strip them to booleans ("present" / not) here. API keys are emitted as non-sensitive
// metadata only (prefix, name, role, timestamps); the key_hash is NEVER included, and the
// clear key cannot be: it is shown once at mint time and never stored.

type ExportApiKeyMeta = {
   id: number,
   name: string,
   key_prefix: string,
   role: string,
   last_used_at: Date | null,
   revoked_at: Date | null,
   createdAt?: Date | null,
   updatedAt?: Date | null,
};

type ExportResponse = {
   exportedAt?: string,
   accountId?: number | null,
   account?: Record<string, unknown> | null,
   apiKeys?: ExportApiKeyMeta[],
   domains?: Record<string, unknown>[],
   keywords?: Record<string, unknown>[],
   crawlerHits?: Record<string, unknown>[],
   events?: Record<string, unknown>[],
   invites?: Record<string, unknown>[],
   featureRequests?: Record<string, unknown>[],
   counts?: Record<string, number>,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<ExportResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return exportData(req, res, account);
}

// Strip the encrypted Search Console blob on a domain down to booleans so we never emit a
// secret. We report only WHETHER credentials are configured, never their (encrypted) value.
const sanitizeDomain = (domain: Domain): Record<string, unknown> => {
   const plain = domain.get({ plain: true }) as Record<string, unknown>;
   let hasSearchConsole = false;
   const sc = plain.search_console;
   if (sc && typeof sc === 'string') {
      try {
         const parsed = JSON.parse(sc);
         hasSearchConsole = Boolean(parsed?.client_email && parsed?.private_key);
      } catch { hasSearchConsole = false; }
   }
   delete plain.search_console;
   return { ...plain, search_console_configured: hasSearchConsole };
};

const exportData = async (req: NextApiRequest, res: NextApiResponse<ExportResponse>, account?: Account2 | null) => {
   try {
      const scope = scopeWhere(account);

      // 1. Domains owned by the caller (or all, for admin / single-tenant).
      const domains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainNames = domains.map((d) => d.domain);

      // 2. Keywords: scoped by owner_id AND restricted to the caller's domain set, so a
      //    caller can never pull keywords for a domain they do not own.
      const keywordWhere = domainNames.length > 0
         ? { ...scope, domain: { [Op.in]: domainNames } }
         : { ...scope, domain: { [Op.in]: [] as string[] } };
      const keywords: Keyword[] = await Keyword.findAll({ where: keywordWhere });

      // 3. Crawler hits have no owner_id column; they are scoped purely by the caller's
      //    owned domain names (the same gate every crawler read uses).
      const crawlerHits: CrawlerHit[] = domainNames.length > 0
         ? await CrawlerHit.findAll({ where: { domain: { [Op.in]: domainNames } }, order: [['hitAt', 'DESC']] })
         : [];

      // 4. Autocapture events: scoped by owner_id AND the caller's domain set.
      const eventWhere = domainNames.length > 0
         ? { ...scope, domain: { [Op.in]: domainNames } }
         : { ...scope, domain: { [Op.in]: [] as string[] } };
      const events: S33kEvent[] = await S33kEvent.findAll({ where: eventWhere });

      // 5. Account + API-key metadata. Only meaningful with MULTI_TENANT on; for the admin /
      //    single-tenant caller account may be null, in which case there is no account row to
      //    emit. NEVER emit key_hash; emit only non-sensitive key metadata.
      let accountMeta: Record<string, unknown> | null = null;
      let apiKeys: ExportApiKeyMeta[] = [];
      if (account && account.ID) {
         const acct = await Account.findOne({ where: { ID: account.ID } });
         accountMeta = acct ? (acct.get({ plain: true }) as Record<string, unknown>) : null;
         const keys = await ApiKey.findAll({ where: { account_id: account.ID } });
         apiKeys = keys.map((k) => {
            const p = k.get({ plain: true }) as Record<string, unknown>;
            return {
               id: p.ID as number,
               name: (p.name as string) || '',
               key_prefix: (p.key_prefix as string) || '',
               role: (p.role as string) || 'admin',
               last_used_at: (p.last_used_at as Date) ?? null,
               revoked_at: (p.revoked_at as Date) ?? null,
               createdAt: (p.createdAt as Date) ?? null,
               updatedAt: (p.updatedAt as Date) ?? null,
            };
         });
      }

      // 6. Feature requests: account-linked text, scoped by owner_id (scope). Part of "everything
      //    s33k holds for you" (security review #3). Admin/single-tenant (scope {}) gets all.
      const featureRequests: FeatureRequest[] = await FeatureRequest.findAll({ where: { ...scope } });

      // 7. Invites tied to this account as inviter, target, or accepted-by. Only meaningful with
      //    MULTI_TENANT on (account present); the table is inert otherwise. Invite has no owner_id,
      //    so it is scoped explicitly by the three account-id columns rather than scopeWhere.
      let invites: Invite[] = [];
      if (account && account.ID) {
         invites = await Invite.findAll({
            where: {
               [Op.or]: [
                  { inviter_account_id: account.ID },
                  { target_account_id: account.ID },
                  { accepted_by_account_id: account.ID },
               ],
            },
         });
      }

      const domainsOut = domains.map(sanitizeDomain);
      const keywordsOut = keywords.map((k) => k.get({ plain: true }) as Record<string, unknown>);
      const crawlerHitsOut = crawlerHits.map((c) => c.get({ plain: true }) as Record<string, unknown>);
      const eventsOut = events.map((e) => e.get({ plain: true }) as Record<string, unknown>);
      const featureRequestsOut = featureRequests.map((f) => f.get({ plain: true }) as Record<string, unknown>);
      // Invites: the secret `code` is stripped (it is a live credential that mints API keys); we
      // export only the non-sensitive invite metadata so the bundle never leaks an active code.
      const invitesOut = invites.map((i) => {
         const p = i.get({ plain: true }) as Record<string, unknown>;
         delete p.code;
         return p;
      });

      return res.status(200).json({
         exportedAt: new Date().toJSON(),
         accountId: account?.ID ?? ADMIN_ACCOUNT_ID,
         account: accountMeta,
         apiKeys,
         domains: domainsOut,
         keywords: keywordsOut,
         crawlerHits: crawlerHitsOut,
         events: eventsOut,
         invites: invitesOut,
         featureRequests: featureRequestsOut,
         counts: {
            domains: domainsOut.length,
            keywords: keywordsOut.length,
            crawlerHits: crawlerHitsOut.length,
            events: eventsOut.length,
            apiKeys: apiKeys.length,
            invites: invitesOut.length,
            featureRequests: featureRequestsOut.length,
         },
      });
   } catch (error) {
      console.log('[ERROR] Exporting account data: ', error);
      return res.status(400).json({ error: 'Error Exporting Account Data.' });
   }
};
