// The single, structured source of s33k's trust facts. SECURITY.md is the prose
// companion to this file; both say the same thing. The GET /api/security route
// returns this object, and the security_facts MCP tool wraps that route, so a
// trial user can ask their own LLM "is this safe? do you train on my data? who
// else can see it?" and get a complete, verifiable, source-cited answer.
//
// This module is intentionally dependency-free (no model imports, no sequelize)
// so the route stays lightweight and the facts can be imported anywhere.

export type SecurityFact = {
   id: string,
   question: string,
   answer: string,
   verifyIn: string[],
};

export type SecurityFacts = {
   principle: string,
   summary: string,
   facts: SecurityFact[],
   subProcessors: { name: string, role: string, notes: string }[],
   trustDoc: string,
};

export const securityFacts: SecurityFacts = {
   principle: 'Verify us, don\'t trust us. s33k is open source and self-hostable, so every claim '
      + 'here can be confirmed by reading the code or by owning the deployment yourself.',
   summary: 'A trial user can start with zero security fear: s33k cannot train on your data (no '
      + 'model-training pipeline exists in the code), one account can never see another\'s data '
      + '(proven by adversarial isolation tests), connected credentials are encrypted at rest, '
      + 'tracking is cookieless with no PII, and you can export or hard-delete everything on demand.',
   facts: [
      {
         id: 'no_training',
         question: 'Do you train on my data?',
         answer: 'No, and it is structurally impossible, not just a policy. s33k has NO '
            + 'model-training pipeline, NO LLM client, and NO embedding or fine-tuning step '
            + 'anywhere in the codebase. The AI features (daily briefing, cross-pillar insights, '
            + 'AI-visibility funnel) are rules-based: s33k runs transparent rules over your own '
            + 'data on the server and hands the structured result to YOUR OWN LLM over MCP for '
            + 'interpretation. Your data never leaves the server for any model.',
         verifyIn: [
            'pages/api/briefing.ts (trust marker + "RULES-BASED. It does NOT call any LLM")',
            'pages/api/insights.ts (trust marker + "RULES-BASED. It does NOT call any LLM")',
            'pages/api/ai-visibility.ts (trust marker + "It NEVER queries an LLM")',
         ],
      },
      {
         id: 'tenant_isolation',
         question: 'Who else can see my data?',
         answer: 'Only you. Every tenant-owned table carries an owner_id, and every read, create, '
            + 'and delete is scoped through one helper (scopeWhere / ownerIdFor in utils/scope.ts) '
            + 'that injects your owner_id into the query. One account can never read or change '
            + 'another account\'s rows. This is proven by adversarial isolation tests, not just '
            + 'claimed.',
         verifyIn: [
            'utils/scope.ts',
            '__tests__/pages/route-scope-isolation.test.ts',
            '__tests__/pages/account-routes-isolation.test.ts',
            '__tests__/utils/scope.test.ts',
         ],
      },
      {
         id: 'encryption_at_rest',
         question: 'Are my connected credentials encrypted?',
         answer: 'Yes. The credentials you connect (Google Search Console, Google Ads, the SERP '
            + 'scraper key) are encrypted at rest with cryptr (AES-256) keyed by the app SECRET, '
            + 'decrypted only in memory to make the call they belong to, and never logged, '
            + 'exported, or sent to a model. API keys are stored as a SHA-256 hash, never as the '
            + 'clear key.',
         verifyIn: [
            'pages/api/domains.ts',
            'pages/api/settings.ts',
            'utils/searchConsole.ts',
            'utils/adwords.ts',
         ],
      },
      {
         id: 'data_ownership',
         question: 'Can I take my data with me or delete it?',
         answer: 'Yes, both. GET /api/export (MCP tool export_data) downloads EVERYTHING s33k holds '
            + 'for your account as one JSON bundle, tenant-scoped and with no secrets included. '
            + 'DELETE /api/account-data (MCP tool delete_account_data) permanently and irreversibly '
            + 'deletes your entire account and all its data; it requires the exact confirmation '
            + '"DELETE", is tenant-scoped to your own data only, and can never delete the root admin '
            + 'account.',
         verifyIn: [
            'pages/api/export.ts',
            'pages/api/account-data.ts',
            'mcp/src/index.ts (export_data, delete_account_data)',
         ],
      },
      {
         id: 'open_source',
         question: 'Can I verify all of this myself?',
         answer: 'Yes. s33k is open source, so you can read every line of code that touches your '
            + 'data, and you can self-host the whole thing on your own infrastructure with your own '
            + 'database so your data never leaves your control. That is the strongest form of '
            + 'verify-don\'t-trust.',
         verifyIn: ['the repository itself', 'SECURITY.md'],
      },
      {
         id: 'cookieless_no_pii',
         question: 'Does your tracking use cookies or collect personal data?',
         answer: 'No. The autocapture script uses no cookies and no fingerprinting; its session id '
            + 'lives in sessionStorage only and rotates daily, so it cannot identify a person or be '
            + 'joined across days. It never reads the value of any input, textarea, select, '
            + 'contenteditable, or password field, and records THAT a form was submitted, never the '
            + 'field values. The server sanitizes every event and drops anything PII-shaped before '
            + 'storing it.',
         verifyIn: [
            'public/s33k.js (PRIVACY header)',
            'pages/api/collect.ts',
            'utils/event-sanitize.ts',
         ],
      },
   ],
   subProcessors: [
      {
         name: 'Railway',
         role: 'Hosting for the managed s33k service plus its Postgres database.',
         notes: 'Self-hosters supply their own host and database (Postgres in prod, SQLite locally).',
      },
      {
         name: 'Umami (self-hosted)',
         role: 'Open-source analytics collection substrate for page traffic.',
         notes: 'Per-domain websites are deleted on account hard-delete (best-effort).',
      },
      {
         name: 'Serper',
         role: 'SERP data for keyword rank tracking.',
         notes: 'Runs server-side on the operator key (scrapers/services/serper.ts); the key is encrypted at rest.',
      },
   ],
   trustDoc: 'SECURITY.md (full prose version of these facts, with a proof index).',
};

export default securityFacts;
