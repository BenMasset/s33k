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
      + 'model-training pipeline exists in the code), one account can never see another\'s data and '
      + 'in multi-tenant mode neither can the operator (proven by adversarial isolation tests), '
      + 'connected credentials and your login email are encrypted at rest (the analytics substrate '
      + 'is plaintext by necessity, the honest residual), privileged operator actions are '
      + 'audit-logged, tracking is cookieless with no PII, and you can export or hard-delete '
      + 'everything on demand.',
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
         question: 'Who else can see my data? Can the operator see it?',
         answer: 'Only you, and NOT the operator either. Every tenant-owned table is scoped to your '
            + 'account through one helper (scopeWhere / ownerIdFor in utils/scope.ts), and the few '
            + 'keyed on the globally-unique domain name are scoped by your owned-domain set, which '
            + 'cannot collide across accounts. Crucially, in multi-tenant mode the operator (the '
            + 'seeded admin) is NOT an unscoped master reader: it is scoped to its OWN data (the '
            + 'legacy null-owner partition), so the operator\'s admin key cannot read any other '
            + 'tenant\'s domains, keywords, rankings, events, dashboards, or reports through any API '
            + 'or MCP route. The operator keeps instance-admin powers (list accounts, mint keys, run '
            + 'the rank sweep) that expose account metadata only, never tenant content, and the one '
            + 'legitimate instance-wide read (the cron rank sweep on the shared SERP key) is named, '
            + 'single-purpose, and audit-logged. The only unscoped-everything mode is a SINGLE-TENANT '
            + 'self-host, where one operator legitimately owns all the data. This is covered by '
            + 'adversarial isolation tests, including an explicit operator-cannot-read-another-tenant '
            + 'test, not just claimed.',
         verifyIn: [
            'utils/scope.ts',
            '__tests__/pages/operator-data-isolation.test.ts',
            '__tests__/pages/route-scope-isolation.test.ts',
            '__tests__/pages/account-routes-isolation.test.ts',
            '__tests__/utils/scope.test.ts',
         ],
      },
      {
         id: 'encryption_at_rest',
         question: 'Are my credentials and login email encrypted? What is NOT encrypted?',
         answer: 'Your connected credentials (Google Search Console, Google Ads, the SERP scraper '
            + 'key) AND your login email are encrypted at rest with cryptr (AES-256) keyed by the app '
            + 'SECRET, decrypted only in memory, and never logged, exported, or sent to a model. The '
            + 'login-email lookup uses a separate keyed HMAC-SHA256 blind index (email_hash) so the '
            + 'plaintext email never hits the database. API keys are stored as a SHA-256 hash, never '
            + 'the clear key. THE HONEST RESIDUAL: your analytics substrate (autocapture events, '
            + 'tracked keywords and their rank history, domain names, AI-crawler hits) is stored in '
            + 'PLAINTEXT, because the server has to compute analytics over it (counts, sessions, '
            + 'rank trends, cross-pillar joins), so it cannot be zero-knowledge. Anyone with physical '
            + 'database or DB-credential access can read that analytics data; only the credentials '
            + 'and the login email are encrypted. This is exactly why self-hosting is the strongest '
            + 'guarantee: own the deployment, own that residual access.',
         verifyIn: [
            'pages/api/domains.ts',
            'pages/api/settings.ts',
            'utils/searchConsole.ts',
            'utils/adwords.ts',
            'utils/accountEmail.ts',
         ],
      },
      {
         id: 'privileged_access_audit',
         question: 'Is the operator\'s access logged?',
         answer: 'Yes, in multi-tenant mode. Every privileged operator action (the cron rank sweep '
            + 'across all tenants, listing or creating accounts, minting or revoking another '
            + 'account\'s key, reading the waitlist or feature requests) is recorded in an audit_log '
            + 'table as metadata only (actor, action, target account/domain, route, time), never '
            + 'tenant content and never secrets. The operator reads the trail at GET /api/audit-log. '
            + 'The writer is best-effort (never blocks a request) and is a no-op on a single-tenant '
            + 'install, so that path is unchanged.',
         verifyIn: [
            'database/models/auditLog.ts',
            'utils/auditLog.ts',
            'pages/api/audit-log.ts',
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
