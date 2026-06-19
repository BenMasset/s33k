/*
 * ============================================================================
 * s33k START HERE: the explicit guided entry point for "I do not know what to ask".
 * ============================================================================
 * A co-founder's V1 review said s33k had "no easy mode": a user connects their
 * LLM and is staring at 80+ tools with no obvious first move. start_here is that
 * first move. Give it a domain (or no domain to pick one) and it returns, in
 * priority order: which domain, your setup state, the single most important thing
 * to do now, and a SHORT curated list of where to look next. It deliberately
 * surfaces entry_pages ("which pages did AI search land on"), which the same
 * reviewer could not find on their own.
 *
 * This file is the PURE shaping layer. It does NO IO: no DB, no network, no auth,
 * no LLM. The route (pages/api/start-here.ts) does the tenant-scoped reads (it
 * reuses the dashboard composer and the onboarding step counts) and hands the
 * already-shaped numbers here. Keeping the shaping pure makes every mode
 * (pick-domain, setup, ready) unit-testable without booting anything, the same
 * way buildDashboard and the analyst engine stay pure.
 * ============================================================================
 */

// --- Setup checklist (the same five steps onboarding-status reports). --------
//
// The route loads the four raw counts (owned, keywords, recent events, goals)
// and hands them here; this pure function turns them into the checklist +
// percentComplete + the single next step, EXACTLY mirroring the steps in
// pages/api/onboarding-status.ts so the two never disagree. start_here only
// needs the next step and the percentage, not the full step array on the wire,
// so it returns a compact result.

/** The raw, already-scoped setup signals the route reads for a domain. */
export type SetupSignals = {
   owned: boolean,
   keywordCount: number,
   recentEvents: number,
   goalCount: number,
   // The domain, used only to phrase the "add your site" step. Optional: start_here always has one
   // by the time it computes setup, and setup_status passes its domain so the wording is unchanged.
   domain?: string,
};

/** One checklist step: matches onboarding-status's Step shape. */
export type SetupStep = { key: string, title: string, done: boolean, detail: string, nextTool: string };

/** The setup state. `steps` is the full checklist; the rest is what start_here acts on. */
export type SetupState = {
   steps: SetupStep[],
   percentComplete: number,
   complete: boolean,
   nextStep: SetupStep | null,
};

/**
 * Compute the setup checklist + percentComplete + next step from the raw counts.
 * Pure, and the SINGLE source of the five setup steps: pages/api/onboarding-status.ts (setup_status)
 * imports this too, so start_here and setup_status can never disagree about setup state.
 *
 * @param {SetupSignals} s - The scoped setup counts for one domain.
 * @returns {SetupState}
 */
export const computeSetupState = (s: SetupSignals): SetupState => {
   const site = s.domain || 'your site';
   const steps: SetupStep[] = [
      {
         key: 'add_domain',
         title: 'Add your site',
         done: s.owned,
         detail: s.owned ? `${site} is being tracked.` : `Add ${site} so s33k can track it.`,
         nextTool: 'onboard (or create_domain)',
      },
      {
         key: 'track_keywords',
         title: 'Track keywords',
         done: s.keywordCount > 0,
         detail: s.keywordCount > 0 ? `${s.keywordCount} keyword(s) tracked.`
            : 'Track the terms you want to rank for so s33k can watch your Google position.',
         nextTool: 'add_keyword (or onboard auto-discovers up to 20)',
      },
      {
         key: 'install_tracking',
         title: 'Install the tracking script',
         done: s.recentEvents > 0,
         detail: s.recentEvents > 0 ? 'The s33k.js script is live and sending data.'
            : 'Add the one-line s33k.js script to your site so traffic, human-vs-bot, and conversions can flow in.',
         nextTool: 'install_instructions',
      },
      {
         key: 'define_goals',
         title: 'Define your conversions',
         done: s.goalCount > 0,
         detail: s.goalCount > 0 ? `${s.goalCount} conversion goal(s) defined.`
            : 'Define what counts as a conversion (a thank-you page, a form submit) so s33k can report conversion rates.',
         nextTool: 'suggest_goals (auto-propose), then create_goal',
      },
      {
         key: 'first_report',
         title: 'See your first report',
         done: s.owned && s.keywordCount > 0 && s.recentEvents > 0,
         detail: 'Get the proactive cross-pillar standup: what is happening and what to do next.',
         nextTool: 'briefing (and conversion_attribution once conversions accrue)',
      },
   ];
   const doneCount = steps.filter((step) => step.done).length;
   const percentComplete = Math.round((100 * doneCount) / steps.length);
   const nextStep = steps.find((step) => !step.done) || null;
   return { steps, percentComplete, complete: nextStep === null, nextStep };
};

// --- The curated "where to look next" pointers. ------------------------------
//
// This is the #3 surfacing the brief demands: the reviewer could not find the
// already-built "which pages did AI search land on" view, so start_here ALWAYS
// points at entry_pages first, then the cheapest SEO wins, then the full
// overview. Short on purpose (3 pointers): a long menu defeats the "easy mode".

/** One next-step pointer: a plain-English label and the exact tool to call. */
export type NextStepPointer = { label: string, tool: string };

/**
 * The fixed, curated pointer list for a fully-set-up domain. Kept verbatim in
 * intent (entry_pages / striking_distance / dashboard) so the AI-landing-pages
 * capability is always surfaced. Returned as a fresh array each call so a caller
 * can never mutate the shared constant.
 *
 * @returns {NextStepPointer[]}
 */
export const readyNextSteps = (): NextStepPointer[] => [
   { label: 'See which pages AI search lands on', tool: 'entry_pages' },
   { label: 'Your quickest SEO wins', tool: 'striking_distance' },
   { label: 'Full cross-pillar overview', tool: 'dashboard' },
];

// --- The ready-mode response shape + its plain-text render. ------------------

/** The inputs the route hands the ready-mode renderer, lifted from the dashboard headline. */
export type ReadyInput = {
   domain: string,
   period: string,
   humanVisitors: number,
   aiReferredVisitors: number,
   topAction: string | null,
};

/** The ready-mode payload start_here returns when a domain is fully set up. */
export type ReadyResult = {
   mode: 'ready',
   domain: string,
   headline: string,
   topAction: string,
   nextSteps: NextStepPointer[],
   rendered: string,
};

/**
 * Compose the one-line "state of the site" headline from the dashboard numbers.
 * Mirrors the dashboard headline's spirit (human visitors, AI-referred visitors)
 * but as a single sentence start_here can lead with.
 *
 * @param {ReadyInput} d - The dashboard-derived numbers for the domain.
 * @returns {string}
 */
const composeHeadline = (d: ReadyInput): string => {
   const ai = d.aiReferredVisitors > 0
      ? `${d.aiReferredVisitors} AI-referred visitor(s)`
      : 'no AI-referred visitors yet';
   return `${d.domain} over ${d.period}: about ${d.humanVisitors} human visitor(s), ${ai}.`;
};

/**
 * Build the compact, ready-to-show plain-text block for ready mode. Matches the
 * monospace, no-color, no-em-dash style of the dashboard/daily_brief rendered
 * blocks so a client can print it verbatim. Intentionally small: a headline, the
 * one top action, and the three pointers.
 *
 * @param {string} headline - The composed state-of-the-site line.
 * @param {string} topAction - The single highest-priority recommendation.
 * @param {NextStepPointer[]} nextSteps - The curated pointer list.
 * @returns {string}
 */
const renderReady = (headline: string, topAction: string, nextSteps: NextStepPointer[]): string => {
   const out: string[] = [];
   out.push('=== START HERE ===');
   out.push(headline);
   out.push('');
   out.push('>> DO THIS NEXT:');
   out.push(`   ${topAction}`);
   out.push('');
   out.push('THEN LOOK AT:');
   nextSteps.forEach((p) => out.push(`   - ${p.label}  ->  ${p.tool}`));
   return out.join('\n');
};

/**
 * Assemble the full ready-mode result (headline + topAction + curated pointers +
 * rendered block) from the dashboard-derived numbers. Pure. The route calls this
 * once it has confirmed setup is complete and composed the dashboard.
 *
 * @param {ReadyInput} d - The dashboard-derived numbers for the domain.
 * @returns {ReadyResult}
 */
export const buildReady = (d: ReadyInput): ReadyResult => {
   const headline = composeHeadline(d);
   // The dashboard composer always sets a topAction, but guard for null so the
   // wire field is never empty (it is the whole point of "do this next").
   const topAction = d.topAction
      || 'No urgent gap this period. Ask dashboard for the full overview, or widen the window (period=90d).';
   const nextSteps = readyNextSteps();
   const rendered = renderReady(headline, topAction, nextSteps);
   return { mode: 'ready', domain: d.domain, headline, topAction, nextSteps, rendered };
};
