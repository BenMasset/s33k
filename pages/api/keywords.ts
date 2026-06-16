import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import { MAX_KEYWORDS_PER_REQUEST, MAX_KEYWORDS_PER_DOMAIN } from '../../utils/limits';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { integrateKeywordSCData, readLocalSCData } from '../../utils/searchConsole';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { getKeywordsVolume, updateKeywordsVolumeData } from '../../utils/adwords';
import { removeFromRetryQueue } from '../../utils/scraper';

type KeywordsGetResponse = {
   keywords?: KeywordType[],
   error?: string|null,
}

type KeywordsDeleteRes = {
   domainRemoved?: number,
   keywordsRemoved?: number,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }

   if (req.method === 'GET') {
      return getKeywords(req, res, account);
   }
   if (req.method === 'POST') {
      return addKeywords(req, res, account);
   }
   if (req.method === 'DELETE') {
      return deleteKeywords(req, res, account);
   }
   if (req.method === 'PUT') {
      return updateKeywords(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const getKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const settings = await getAppSettings();
   const domain = (req.query.domain as string);
   const integratedSC = process.env.SEARCH_CONSOLE_PRIVATE_KEY && process.env.SEARCH_CONSOLE_CLIENT_EMAIL;
   const { search_console_client_email, search_console_private_key } = settings;
   const domainSCData = integratedSC || (search_console_client_email && search_console_private_key) ? await readLocalSCData(domain) : false;

   try {
      const allKeywords:Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));
      const processedKeywords = keywords.map((keyword) => {
         const historyArray = Object.keys(keyword.history).map((dateKey:string) => ({
            date: new Date(dateKey).getTime(),
            dateRaw: dateKey,
            position: keyword.history[dateKey],
         }));
         const historySorted = historyArray.sort((a, b) => a.date - b.date);
         const lastWeekHistory :KeywordHistory = {};
         historySorted.slice(-7).forEach((x:any) => { lastWeekHistory[x.dateRaw] = x.position; });
         const keywordWithSlimHistory = { ...keyword, lastResult: [], history: lastWeekHistory };
         const finalKeyword = domainSCData ? integrateKeywordSCData(keywordWithSlimHistory, domainSCData) : keywordWithSlimHistory;
         return finalKeyword;
      });
      return res.status(200).json({ keywords: processedKeywords });
   } catch (error) {
      console.log('[ERROR] Getting Domain Keywords for ', domain, error);
      return res.status(400).json({ error: 'Error Loading Keywords for this Domain.' });
   }
};

const addKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   const { keywords } = req.body;
   if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      // Per-request cap. Bounds one bulk insert and the scrape burst it queues.
      if (keywords.length > MAX_KEYWORDS_PER_REQUEST) {
         return res.status(400).json({ error: `Too many keywords in one request (max ${MAX_KEYWORDS_PER_REQUEST}).` });
      }
      // Every keyword must name a domain.
      if (keywords.some((k: KeywordAddPayload) => !k || typeof k.domain !== 'string' || !k.domain.trim())) {
         return res.status(400).json({ error: 'Every keyword must include a domain.' });
      }

      // OWNERSHIP GATE (security review #2): the caller must OWN every domain they add
      // keywords for, before any cost-bearing bulkCreate + scrape. scopeWhere is {} when
      // MULTI_TENANT is off (so this just requires the domain to exist, which is correct),
      // and enforces owner_id when on (so a tenant cannot add keywords against another
      // tenant's domain string, burn the operator's SERP quota, or skew their stats).
      const requestedDomains = Array.from(new Set(keywords.map((k: KeywordAddPayload) => k.domain.trim())));
      const ownedDomains = await Domain.findAll({ where: { domain: { [Op.in]: requestedDomains }, ...scopeWhere(account) } });
      const ownedDomainSet = new Set(ownedDomains.map((d) => d.domain));
      const unowned = requestedDomains.filter((d) => !ownedDomainSet.has(d));
      if (unowned.length > 0) {
         return res.status(403).json({ error: `Domain not found for this account: ${unowned.join(', ')}` });
      }

      // PER-DOMAIN CAP (security review #2 / #6): the keyword-cap claim in the product's
      // own knowledge facts is enforced here. Count existing tracked keywords per domain
      // and reject if this request would push any domain over the cap.
      const newByDomain: Record<string, number> = {};
      for (const k of keywords as KeywordAddPayload[]) { newByDomain[k.domain.trim()] = (newByDomain[k.domain.trim()] || 0) + 1; }
      for (const domain of requestedDomains) {
         // eslint-disable-next-line no-await-in-loop
         const existing = await Keyword.count({ where: { domain, ...scopeWhere(account) } });
         if (existing + newByDomain[domain] > MAX_KEYWORDS_PER_DOMAIN) {
            return res.status(400).json({
               error: `Keyword cap reached for ${domain} (max ${MAX_KEYWORDS_PER_DOMAIN}; ${existing} already tracked).`,
            });
         }
      }

      const keywordsToAdd: any = []; // QuickFIX for bug: https://github.com/sequelize/sequelize-typescript/issues/936
      const owner_id = ownerIdFor(account);
      // Dedupe within the request by the natural key, so a single call cannot insert (and
      // pay to scrape) the same keyword+device+country+domain twice.
      const seen = new Set<string>();

      keywords.forEach((kwrd: KeywordAddPayload) => {
         const { keyword, device, country, domain, tags, city, target_page } = kwrd;
         const dedupeKey = `${(keyword || '').trim().toLowerCase()}|${device}|${country}|${domain.trim()}`;
         if (seen.has(dedupeKey)) { return; }
         seen.add(dedupeKey);
         const tagsArray = tags ? tags.split(',').map((item:string) => item.trim()) : [];
         const newKeyword = {
            keyword,
            device,
            domain,
            country,
            city,
            target_page: target_page || '',
            position: 0,
            updating: true,
            history: JSON.stringify({}),
            url: '',
            tags: JSON.stringify(tagsArray),
            sticky: false,
            lastUpdated: new Date().toJSON(),
            added: new Date().toJSON(),
            owner_id,
         };
         keywordsToAdd.push(newKeyword);
      });

      try {
         const newKeywords:Keyword[] = await Keyword.bulkCreate(keywordsToAdd);
         const formattedkeywords = newKeywords.map((el) => el.get({ plain: true }));
         const keywordsParsed: KeywordType[] = parseKeywords(formattedkeywords);

         // Queue the SERP Scraping Process
         const settings = await getAppSettings();
         refreshAndUpdateKeywords(newKeywords, settings);

         // Update the Keyword Volume
         const { adwords_account_id, adwords_client_id, adwords_client_secret, adwords_developer_token } = settings;
         if (adwords_account_id && adwords_client_id && adwords_client_secret && adwords_developer_token) {
            const keywordsVolumeData = await getKeywordsVolume(keywordsParsed);
            if (keywordsVolumeData.volumes !== false) {
               await updateKeywordsVolumeData(keywordsVolumeData.volumes);
            }
         }

         return res.status(201).json({ keywords: keywordsParsed });
      } catch (error) {
         console.log('[ERROR] Adding New Keywords ', error);
         return res.status(400).json({ error: 'Could Not Add New Keyword!' });
      }
   } else {
      return res.status(400).json({ error: 'Necessary Keyword Data Missing' });
   }
};

const deleteKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsDeleteRes>, account?: Account | null) => {
   if (!req.query.id && typeof req.query.id !== 'string') {
      return res.status(400).json({ error: 'keyword ID is Required!' });
   }
   console.log('req.query.id: ', req.query.id);

   try {
      const keywordsToRemove = (req.query.id as string).split(',').map((item) => parseInt(item, 10));
      const removeQuery = { where: { ID: { [Op.in]: keywordsToRemove }, ...scopeWhere(account) } };
      const removedKeywordCount: number = await Keyword.destroy(removeQuery);

      // remove keyword from retry queue if exists
      await Promise.all(keywordsToRemove.map((keywordID) => removeFromRetryQueue(keywordID)));

      return res.status(200).json({ keywordsRemoved: removedKeywordCount });
   } catch (error) {
      console.log('[ERROR] Removing Keyword. ', error);
      return res.status(400).json({ error: 'Could Not Remove Keyword!' });
   }
};

const updateKeywords = async (req: NextApiRequest, res: NextApiResponse<KeywordsGetResponse>, account?: Account | null) => {
   if (!req.query.id && typeof req.query.id !== 'string') {
      return res.status(400).json({ error: 'keyword ID is Required!' });
   }
   if (req.body.sticky === undefined && !req.body.tags === undefined && req.body.target_page === undefined) {
      return res.status(400).json({ error: 'keyword Payload Missing!' });
   }
   const keywordIDs = (req.query.id as string).split(',').map((item) => parseInt(item, 10));
   const { sticky, tags, target_page } = req.body;

   try {
      const scope = scopeWhere(account);
      let keywords: KeywordType[] = [];
      if (target_page !== undefined) {
         await Keyword.update({ target_page }, { where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const updatedKeywords:Keyword[] = await Keyword.findAll({ where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const formattedKeywords = updatedKeywords.map((el) => el.get({ plain: true }));
         keywords = parseKeywords(formattedKeywords);
         return res.status(200).json({ keywords });
      }
      if (sticky !== undefined) {
         await Keyword.update({ sticky }, { where: { ID: { [Op.in]: keywordIDs }, ...scope } });
         const updateQuery = { where: { ID: { [Op.in]: keywordIDs }, ...scope } };
         const updatedKeywords:Keyword[] = await Keyword.findAll(updateQuery);
         const formattedKeywords = updatedKeywords.map((el) => el.get({ plain: true }));
          keywords = parseKeywords(formattedKeywords);
         return res.status(200).json({ keywords });
      }
      if (tags) {
         const tagsKeywordIDs = Object.keys(tags);
         const multipleKeywords = tagsKeywordIDs.length > 1;
         for (const keywordID of tagsKeywordIDs) {
            const selectedKeyword = await Keyword.findOne({ where: { ID: keywordID, ...scope } });
            const currentTags = selectedKeyword && selectedKeyword.tags ? JSON.parse(selectedKeyword.tags) : [];
            const mergedTags = Array.from(new Set([...currentTags, ...tags[keywordID]]));
            if (selectedKeyword) {
               await selectedKeyword.update({ tags: JSON.stringify(multipleKeywords ? mergedTags : tags[keywordID]) });
            }
         }
         return res.status(200).json({ keywords });
      }
      return res.status(400).json({ error: 'Invalid Payload!' });
   } catch (error) {
      console.log('[ERROR] Updating Keyword. ', error);
      return res.status(200).json({ error: 'Error Updating keywords!' });
   }
};
