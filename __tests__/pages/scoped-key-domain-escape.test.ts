/**
 * SECURITY REGRESSION: scoped-key domain-escape via normalization mismatch.
 *
 * The bug: a per-domain read-only SHARE key (ApiKey.scoped_domain) was enforced in authorize() by
 * BYTE-comparing req.query.domain to scoped_domain, but several routes RE-DERIVED the domain after
 * the gate (a slug-decode that turns "a-b.com" into "a.b.com", or a www/protocol strip). The gate
 * checked one string and the route looked up a DIFFERENT one, so a scoped key for "a-b.com" could
 * read the sibling "a.b.com" the owner also owns. Escape.
 *
 * The fix: canonicalize BOTH sides of the gate, and make every fixed route resolve the CANONICAL
 * domain FIRST (falling back to the legacy slug-decode only when canonical matched nothing). This
 * suite drives the REAL authorize() gate and the REAL route handlers end to end (only the DB model
 * and pure side-effect helpers are mocked) and proves:
 *   1. a scoped key for "a-b.com" CANNOT read "a.b.com" through insight / searchconsole /
 *      install-instructions (the route resolves the dashed domain, never the dotted sibling), and
 *   2. a scoped key for "example.com" is still ALLOWED to read ?domain=example.com.
 *
 * No network, no real DB: database/database is a no-op, the Domain model + searchConsole + install
 * guides are jest mocks. The api_key + account lookups inside resolveAccount are mocked so the share
 * key resolves for real through authorize().
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// The two sibling domains the owner controls. resolveDomainAccess does Domain.findOne({ where:
// { domain, ...scopeWhere(account) } }); we return a row ONLY for an exact domain-name match, so the
// test can detect which string the route actually looked up. owner_id 2 == the share key's account.
// The factory is hoisted above module init, so the rows + findOne are DEFINED INSIDE it and captured
// back out via jest.requireMock after the import section.
jest.mock('../../database/models/domain', () => {
   const rows: Record<string, { domain: string, owner_id: number }> = {
      'a-b.com': { domain: 'a-b.com', owner_id: 2 },
      'a.b.com': { domain: 'a.b.com', owner_id: 2 },
      'example.com': { domain: 'example.com', owner_id: 2 },
   };
   const findOne = jest.fn(async ({ where }: { where: { domain: string } }) => {
      const row = rows[where.domain];
      if (!row) { return null; }
      return { ...row, get: (opt?: unknown) => (opt && (opt as { plain?: boolean }).plain ? { ...row } : row.domain) };
   });
   return { __esModule: true, default: { findOne, findAll: jest.fn(async () => []) } };
});

// Share key resolution: a member key with scoped_domain on an active account, looked up by prefix.
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

// Search Console side effects: never hit disk/network. readLocalSCData returns false so the routes
// fall through to the (also mocked) api-info path, where we assert which domain was resolved.
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   readLocalSCData: jest.fn(async () => false),
   getSearchConsoleConnectionStatus: jest.fn(async () => null),
   getSearchConsoleApiInfo: jest.fn(async () => ({})),
   hasSearchConsoleCredentials: jest.fn(() => false),
   fetchDomainSCData: jest.fn(async () => ({})),
   clearSearchConsoleOAuthToken: jest.fn(async () => true),
}));
jest.mock('../../utils/install-guides', () => ({
   __esModule: true,
   getInstallGuides: jest.fn((domain: string) => ({ snippet: `snippet-for-${domain}`, guides: [] })),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import insightHandler from '../../pages/api/insight';
// eslint-disable-next-line import/first
import searchconsoleHandler from '../../pages/api/searchconsole';
// eslint-disable-next-line import/first
import installInstructionsHandler from '../../pages/api/install-instructions';
// eslint-disable-next-line import/first
import { hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';

const mockApiKey = ApiKeyModel as unknown as { findOne: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };
const domainFindOne = (DomainModel as unknown as { findOne: jest.Mock }).findOne;

const ORIGINAL_ENV = { ...process.env };

// Mint a deterministic share key scoped to a given domain (member role, account 2, active).
const wireShareKey = (key: string, scopedDomain: string) => {
   mockApiKey.findOne.mockImplementation(async ({ where }: { where: { key_prefix: string } }) => {
      if (where.key_prefix === apiKeyPrefix(key)) {
         return {
            ID: 80,
            account_id: 2,
            key_prefix: apiKeyPrefix(key),
            key_hash: hashApiKey(key),
            role: 'member',
            scoped_domain: scopedDomain,
            revoked_at: null,
            save: jest.fn(async () => undefined),
         };
      }
      return null;
   });
   mockAccount.findOne.mockImplementation(async ({ where }: { where: { ID: number } }) => (
      { ID: where.ID, name: `Account ${where.ID}`, status: 'active' }
   ));
};

// url must be a real whitelisted route: authorize() also enforces the API-route whitelist for Bearer
// callers (isAllowedApiRoute matches "GET:/api/insight" etc.), so each handler gets its own path.
const makeReq = (key: string, domain: string, url: string): NextApiRequest => ({
   method: 'GET',
   url,
   query: { domain },
   headers: { authorization: `Bearer ${key}` },
   body: {},
} as unknown as NextApiRequest);

const URLS = {
   insight: '/api/insight',
   searchconsole: '/api/searchconsole',
   install: '/api/install-instructions',
};

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.getHeader = () => undefined;
   res.setHeader = () => undefined;
   return res as unknown as NextApiResponse & { statusCode: number, payload: unknown };
};

// Distinct 12-char prefixes (apiKeyPrefix = first 12 chars) so the two keys never collide on lookup.
const SHARE_KEY_AB = 's33k_ab01_for_a_dash_b_dot_com_abcdefgh';
const SHARE_KEY_EXAMPLE = 's33k_ex02_for_example_dot_com_ijklmnop';

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = 'unit-test-secret';
   process.env.MULTI_TENANT = 'true';
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('scoped key for a DASHED domain cannot escape to its dotted sibling', () => {
   // The whole exploit: ?domain=a-b.com passes the byte-equal gate (scoped_domain === "a-b.com"),
   // and the OLD route then slug-decoded "a-b.com" -> "a.b.com" and read THAT. After the fix, every
   // route resolves the canonical "a-b.com" first, so it never touches the "a.b.com" row.

   const assertResolvedDashedNotDotted = () => {
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      // The dashed domain MUST have been the resolving lookup.
      expect(lookedUp).toContain('a-b.com');
      // The dotted sibling MUST NEVER have been looked up: the slug-decode fallback only runs when
      // canonical matched nothing, and "a-b.com" matches, so "a.b.com" is unreachable here.
      expect(lookedUp).not.toContain('a.b.com');
   };

   it('insight: ?domain=a-b.com resolves a-b.com, never a.b.com', async () => {
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await insightHandler(makeReq(SHARE_KEY_AB, 'a-b.com', URLS.insight), res);
      // Not a 401/403: the gate allowed it (it targets its own scoped domain) and the route resolved it.
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      assertResolvedDashedNotDotted();
   });

   it('searchconsole: ?domain=a-b.com resolves a-b.com, never a.b.com', async () => {
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await searchconsoleHandler(makeReq(SHARE_KEY_AB, 'a-b.com', URLS.searchconsole), res);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      assertResolvedDashedNotDotted();
   });

   it('install-instructions: ?domain=a-b.com resolves a-b.com, never a.b.com', async () => {
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await installInstructionsHandler(makeReq(SHARE_KEY_AB, 'a-b.com', URLS.install), res);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      expect(lookedUp).toContain('a-b.com');
      expect(lookedUp).not.toContain('a.b.com');
      // And it returns the install snippet for the dashed domain, not the sibling.
      expect((res.payload as { domain?: string }).domain).toBe('a-b.com');
   });
});

describe('install-instructions: a non-canonical request cannot pass the gate then resolve a sibling', () => {
   // The canonicalize-before-gate variant: scoped_domain is stored canonical ("example.com"), and a
   // request must canonicalize to it to pass the gate. "www.example.com" canonicalizes to
   // "example.com" on BOTH the gate side and the route side, so it resolves example.com (its own
   // domain), and there is no second domain it could divert to.
   it('?domain=www.example.com with a scoped key for example.com resolves example.com', async () => {
      wireShareKey(SHARE_KEY_EXAMPLE, 'example.com');
      const res = makeRes();
      await installInstructionsHandler(makeReq(SHARE_KEY_EXAMPLE, 'www.example.com', URLS.install), res);
      expect(res.statusCode).toBe(200);
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      expect(lookedUp).toContain('example.com');
      expect((res.payload as { domain?: string }).domain).toBe('example.com');
   });
});

describe('a scoped key for example.com is still ALLOWED to read its own domain', () => {
   it('insight: ?domain=example.com is authorized (not 401/403) and resolves example.com', async () => {
      wireShareKey(SHARE_KEY_EXAMPLE, 'example.com');
      const res = makeRes();
      await insightHandler(makeReq(SHARE_KEY_EXAMPLE, 'example.com', URLS.insight), res);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      expect(lookedUp).toContain('example.com');
   });

   it('searchconsole + install-instructions also allow the scoped domain itself', async () => {
      wireShareKey(SHARE_KEY_EXAMPLE, 'example.com');
      const scRes = makeRes();
      await searchconsoleHandler(makeReq(SHARE_KEY_EXAMPLE, 'example.com', URLS.searchconsole), scRes);
      expect(scRes.statusCode).not.toBe(401);
      expect(scRes.statusCode).not.toBe(403);

      const iiRes = makeRes();
      await installInstructionsHandler(makeReq(SHARE_KEY_EXAMPLE, 'example.com', URLS.install), iiRes);
      expect(iiRes.statusCode).toBe(200);
      expect((iiRes.payload as { domain?: string }).domain).toBe('example.com');
   });
});

describe('no slug-decode escape: the dotted sibling is NEVER queried, even on a canonical miss (d)', () => {
   // The slug-decode fallback ("-" -> ".") was removed entirely (third adversarial review). Even if
   // the canonical "a-b.com" row did NOT exist, the route must NOT fall back to looking up the dotted
   // sibling "a.b.com". A scoped key for "a-b.com" whose canonical row is absent gets a clean 403 and
   // touches no sibling row.
   const assertNeverQueriedDottedSibling = () => {
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      expect(lookedUp).not.toContain('a.b.com');
   };

   it('insight: a scoped key for a-b.com never resolves a.b.com via a slug-decode on a canonical miss', async () => {
      // Force the canonical "a-b.com" lookup to miss so the OLD code would have slug-decoded to a.b.com.
      domainFindOne.mockImplementation(async ({ where }: { where: { domain: string } }) => (
         where.domain === 'a.b.com' ? { domain: 'a.b.com', owner_id: 2, get: () => 'a.b.com' } : null
      ));
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await insightHandler(makeReq(SHARE_KEY_AB, 'a-b.com', URLS.insight), res);
      // Canonical row absent => 403, and crucially the dotted sibling was never queried.
      expect(res.statusCode).toBe(403);
      assertNeverQueriedDottedSibling();
   });

   it('searchconsole: same, no slug-decode to the dotted sibling on a canonical miss', async () => {
      domainFindOne.mockImplementation(async ({ where }: { where: { domain: string } }) => (
         where.domain === 'a.b.com' ? { domain: 'a.b.com', owner_id: 2, get: () => 'a.b.com' } : null
      ));
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await searchconsoleHandler(makeReq(SHARE_KEY_AB, 'a-b.com', URLS.searchconsole), res);
      expect(res.statusCode).toBe(403);
      assertNeverQueriedDottedSibling();
   });
});

describe('the gate still REJECTS a scoped key aimed at a foreign domain', () => {
   it('insight: scoped key for a-b.com is 401-rejected when it requests example.com', async () => {
      wireShareKey(SHARE_KEY_AB, 'a-b.com');
      const res = makeRes();
      await insightHandler(makeReq(SHARE_KEY_AB, 'example.com', URLS.insight), res);
      // authorize() denies at the gate (canonical example.com !== canonical a-b.com), so the handler
      // returns 401 and never resolves any domain.
      expect(res.statusCode).toBe(401);
      const lookedUp = domainFindOne.mock.calls.map((c) => (c[0] as { where: { domain: string } }).where.domain);
      expect(lookedUp).not.toContain('example.com');
   });
});
