import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';

// GET /api/onboarding-status?domain=...
//
// The guided-setup walkthrough, in s33k's no-UI, LLM-native shape. It reports where a user is in
// setup (domain added, keywords tracked, tracking script live, conversion goals defined) and the
// single next step with the exact tool to call. The user's own LLM uses this to walk a new user
// from zero to value conversationally, so onboarding is a guided walkthrough, not a blank slate.

type Step = { key: string, title: string, done: boolean, detail: string, nextTool: string };
type Resp = {
   domain?: string,
   percentComplete?: number,
   steps?: Step[],
   nextStep?: Step | null,
   message?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getStatus(req, res, account);
}

const getStatus = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   try {
      const scope = scopeWhere(account);
      const owned = await Domain.findOne({ where: { domain, ...scope } });
      // Recent events = the tracking script is live and sending. 7-day window.
      const weekAgo = new Date(Date.now() - 7 * 86400e3).toJSON();
      const [keywordCount, recentEvents, goalCount] = await Promise.all([
         owned ? Keyword.count({ where: { domain, ...scope } }) : Promise.resolve(0),
         owned ? S33kEvent.count({ where: { domain, created: { [Op.gte]: weekAgo }, ...scope } }) : Promise.resolve(0),
         owned ? Goal.count({ where: { domain, ...scope } }) : Promise.resolve(0),
      ]);

      const steps: Step[] = [
         {
            key: 'add_domain',
            title: 'Add your site',
            done: Boolean(owned),
            detail: owned ? `${domain} is being tracked.` : `Add ${domain} so s33k can track it.`,
            nextTool: 'onboard (or create_domain)',
         },
         {
            key: 'track_keywords',
            title: 'Track keywords',
            done: keywordCount > 0,
            detail: keywordCount > 0 ? `${keywordCount} keyword(s) tracked.`
               : 'Track the terms you want to rank for so s33k can watch your Google position.',
            nextTool: 'add_keyword (or onboard auto-discovers up to 20)',
         },
         {
            key: 'install_tracking',
            title: 'Install the tracking script',
            done: recentEvents > 0,
            detail: recentEvents > 0 ? 'The s33k.js script is live and sending data.'
               : 'Add the one-line s33k.js script to your site so traffic, human-vs-bot, and conversions can flow in.',
            nextTool: 'install_instructions',
         },
         {
            key: 'define_goals',
            title: 'Define your conversions',
            done: goalCount > 0,
            detail: goalCount > 0 ? `${goalCount} conversion goal(s) defined.`
               : 'Define what counts as a conversion (a thank-you page, a form submit) so s33k can report conversion rates.',
            nextTool: 'suggest_goals (auto-propose), then create_goal',
         },
         {
            key: 'first_report',
            title: 'See your first report',
            done: Boolean(owned) && keywordCount > 0 && recentEvents > 0,
            detail: 'Get the proactive cross-pillar standup: what is happening and what to do next.',
            nextTool: 'briefing (and conversion_attribution once conversions accrue)',
         },
      ];

      const doneCount = steps.filter((s) => s.done).length;
      const percentComplete = Math.round((100 * doneCount) / steps.length);
      const nextStep = steps.find((s) => !s.done) || null;
      const message = nextStep
         ? `Setup is ${percentComplete}% done. Next: ${nextStep.title}. ${nextStep.detail} Use ${nextStep.nextTool}.`
         : `Setup is complete for ${domain}. Ask for a briefing to see what to work on.`;

      return res.status(200).json({ domain, percentComplete, steps, nextStep, message, error: null });
   } catch (error) {
      console.log('[ERROR] Building onboarding status for ', domain, error);
      return res.status(400).json({ error: 'Error Building Onboarding Status for this Domain.' });
   }
};
