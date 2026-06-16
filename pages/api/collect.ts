import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import { sanitizeBatch, sanitizeSession } from '../../utils/event-sanitize';
import { isLikelyBotUA, clientIp, rateLimitCollect } from '../../utils/collect-guards';

// POST /api/collect  (PUBLIC, no API key)
//
// This is the autocapture ingest. The s33k.js client on a customer's website posts batches of
// engagement events here. It is the GA4-killer feature's write half: one script tag, zero
// per-element setup. It takes NO auth and NO API key on purpose, because the script running in
// a stranger's browser cannot hold a secret. It is therefore deliberately NOT in
// utils/allowedApiRoutes.ts (that list gates Bearer-key callers; this route is reached without
// a key, exactly like the public POST /api/waitlist and the invite-accept route).
//
// Because it is open, it defends itself:
//   1. Domain allow-listing: the posted domain MUST be a known s33k Domain, else 403. An
//      unknown domain cannot write a single row, so the endpoint is not an open sink.
//   2. Bot filtering: known crawlers and obvious non-browser user-agents are dropped, so
//      autocapture stays human engagement.
//   3. Rate limiting: a per-(ip+domain) sliding window caps how many rows one source can add.
//   4. PII defense-in-depth: every event is sanitized; anything PII-shaped (an email, a card
//      number, a typed value smuggled into a label) is DROPPED before it can be stored. The
//      client is built to never read input values; this is the second wall behind that.
//   5. Tenant stamping: owner_id is copied from the owning Domain so every read surface scopes
//      by owner_id and a tenant only ever reads its own events.
//
// It NEVER 500s on a bad event: invalid/PII events are skipped and the rest are stored
// (skip-and-continue). A genuinely broken request gets a 4xx, never a stack trace.

type CollectResponse = {
   recorded?: number,
   skipped?: number,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CollectResponse>) {
   // CORS: this is posted cross-origin from customer sites. Allow it, but only POST.
   res.setHeader('Access-Control-Allow-Origin', '*');
   res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

   if (req.method === 'OPTIONS') {
      return res.status(204).end();
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }

   await db.sync();
   return collect(req, res);
}

const collect = async (req: NextApiRequest, res: NextApiResponse<CollectResponse>) => {
   try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
      const session = sanitizeSession(body.session);

      if (!domain) {
         return res.status(400).json({ error: 'Domain is Required!' });
      }

      // 2. Bot filtering: drop crawler / non-browser traffic up front.
      const userAgent = req.headers['user-agent'];
      if (isLikelyBotUA(typeof userAgent === 'string' ? userAgent : undefined)) {
         return res.status(200).json({ recorded: 0, skipped: 0, error: null });
      }

      // 4a. Sanitize + PII-strip the batch BEFORE any DB work. Invalid/PII events are dropped.
      const clean = sanitizeBatch(Array.isArray(body.events) ? body.events : []);
      const submitted = Array.isArray(body.events) ? body.events.length : 0;
      if (clean.length === 0) {
         // Nothing valid to store. Not an error from the client's point of view.
         return res.status(200).json({ recorded: 0, skipped: submitted, error: null });
      }

      // 3. Rate limit per (ip + domain). A flood is silently accepted-as-zero (200) so the
      // client does not retry-storm; it just stops being recorded for the window.
      const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
      if (!rateLimitCollect(ip, domain, clean.length)) {
         return res.status(200).json({ recorded: 0, skipped: submitted, error: null });
      }

      // 1. Domain allow-listing: the domain must be a known s33k Domain. Unknown -> 403.
      // owner_id is read here so it can be stamped on every event row for tenant-scoped reads.
      const owned = await Domain.findOne({ where: { domain } });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found' });
      }
      const ownerId = (owned.owner_id ?? null) as number | null;

      // 5 + skip-and-continue: store each clean event; a single bad row never fails the batch.
      const created = new Date().toJSON();
      let recorded = 0;
      for (const ev of clean) {
         try {
            // eslint-disable-next-line no-await-in-loop
            await S33kEvent.create({
               domain,
               owner_id: ownerId,
               type: ev.type,
               page: ev.page,
               label: ev.label,
               selector: ev.selector,
               value: ev.value,
               session,
               created,
            });
            recorded += 1;
         } catch (rowError) {
            // Skip the offending row, keep going. Never let one event 500 the batch.
            console.log('[WARN] Skipping bad collect event for ', domain, rowError);
         }
      }

      return res.status(200).json({ recorded, skipped: submitted - recorded, error: null });
   } catch (error) {
      // Last-resort guard: even an unexpected failure returns a clean 400, never a stack trace.
      console.log('[ERROR] Collecting events: ', error);
      return res.status(400).json({ error: 'Error collecting events.' });
   }
};
