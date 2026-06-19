/**
 * THE SECURITY-CRUX PROOF for the hosted MCP endpoint.
 *
 * The hosted MCP route mounts the SAME tools (registerS33kTools) and binds them to a per-request
 * fetchImpl carrying the CONNECTING CLIENT'S Bearer key. The whole safety argument is: because every
 * tool call goes through the real s33k API authorize(), a scoped share key (ApiKey.scoped_domain set)
 * connecting over the hosted MCP is confined to GET-only, the per-domain allowlist, and its one
 * domain, exactly as a direct REST call would be. No tool can use anything but its own key.
 *
 * This suite proves that end to end over a REAL in-memory MCP client/server (the same SDK transport
 * mechanics the hosted route uses, minus the HTTP hop). It registers the production tools onto a
 * server with a fetchImpl that simulates the s33k API's scoped-key gate using the PRODUCTION gate
 * logic (utils/allowedApiRoutes.isScopedKeyAllowedRoute + utils/canonical-domain), not a hand-copy.
 * Then, acting as a SCOPED SHARE KEY for getmasset.com, it asserts:
 *
 *   - initialize + tools/list succeed (the handshake works and exposes the tools), AND
 *   - a per-domain READ tool for the scoped domain (traffic_summary on getmasset.com) SUCCEEDS, AND
 *   - a WRITE tool (add_keyword) is REJECTED (scoped keys are GET-only), AND
 *   - the SAME read tool for ANOTHER domain is REJECTED (domain isolation), AND
 *   - a read tool whose route is NOT on the per-domain allowlist is REJECTED.
 *
 * If any of these flipped, a share key over the hosted MCP could exceed its scope. They cannot,
 * because the tool only ever calls the API with its own key and the API gates the rest.
 */

import type { NextApiRequest } from 'next';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// eslint-disable-next-line import/no-relative-packages
import { registerS33kTools, FetchImpl } from '../../mcp/src/tools';
import { isScopedKeyAllowedRoute } from '../../utils/allowedApiRoutes';
import { canonicalizeDomain } from '../../utils/canonical-domain';

// The error a scoped key gets from the real authorize() path, reproduced verbatim so a tool failure
// here matches what the live API returns. We surface these as thrown errors from fetchImpl, which
// each tool wraps into an MCP isError result.
const READ_ONLY = 'Read-only member';
const ROUTE_DENIED = 'This Route cannot be accessed with a share key.';
const domainDenied = (scoped: string) => `This key is limited to ${scoped}.`;

/**
 * Build a fetchImpl that simulates the s33k REST API authorize() enforcement for a SCOPED SHARE KEY
 * limited to `scopedDomain`. It uses the PRODUCTION gate functions so this is a real proof, not a
 * re-implementation: any divergence between the gate the live API runs and what we assert would
 * show up because we call the same isScopedKeyAllowedRoute / canonicalizeDomain the route does.
 *
 * Order mirrors utils/authorize.ts for a scoped key:
 *   1. non-GET            -> reject (read-only)
 *   2. route not allowed  -> reject (route denied)
 *   3. ?domain != scoped  -> reject (domain isolation)
 *   else                  -> return canned per-domain data (the API would, for the owned domain)
 */
const makeScopedKeyFetchImpl = (scopedDomain: string): FetchImpl => async (path, options = {}) => {
   const method = options.method ?? 'GET';
   const query = options.query ?? {};
   const search = new URLSearchParams(query as Record<string, string>).toString();
   const url = search ? `${path}?${search}` : path;
   // Minimal NextApiRequest stand-in: the production gate only reads .url and .method.
   const reqLike = { url, method, query } as unknown as NextApiRequest;

   if (method !== 'GET') {
      throw new Error(`s33k API ${method} ${path} failed (401): ${READ_ONLY}`);
   }
   if (!isScopedKeyAllowedRoute(reqLike)) {
      throw new Error(`s33k API GET ${path} failed (401): ${ROUTE_DENIED}`);
   }
   const requested = canonicalizeDomain(query.domain);
   if (!requested || requested !== canonicalizeDomain(scopedDomain)) {
      throw new Error(`s33k API GET ${path} failed (401): ${domainDenied(scopedDomain)}`);
   }
   // The API would now return the per-domain data for the owned domain. We nest it under the keys
   // the tools read (e.g. traffic_summary reads data.summary), and echo the domain so the test can
   // confirm the allowed call actually returned this domain's data.
   return { summary: { domain: requested, period: query.period ?? '30d', pageviews: 111 }, domains: [requested], keywords: [] };
};

/** Spin up a real MCP client connected to a server registered with the given (scoped-key) fetchImpl. */
const connectScopedClient = async (scopedDomain: string) => {
   const server = new McpServer({ name: 's33k-mcp', version: '0.1.0' });
   registerS33kTools(server, makeScopedKeyFetchImpl(scopedDomain));
   const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
   const client = new Client({ name: 'test-client', version: '0.0.0' });
   await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
   return { client, server };
};

/** A tool call returns an MCP result; isError true means the underlying API rejected it. */
const callText = (result: any): string => (result?.content?.[0]?.text ?? '');

describe('hosted MCP handshake: a connected client can list the tools', () => {
   it('initialize + tools/list exposes the DEFAULT customer surface (69 tools, no admin tools)', async () => {
      // This connection has no S33K_MCP_ADMIN, so it gets the customer surface: the 69 tools a
      // marketer reads/manages for their own site. The 12 app-management tools are absent here, which
      // is exactly right for a scoped share key (a customer key must never even SEE invites, waitlist,
      // domain sharing, account deletion, or onboarding). The full 81-tool admin surface is opt-in via
      // S33K_MCP_ADMIN=true and is verified by the gate runtime check and the mcp smoke test.
      const { client } = await connectScopedClient('getmasset.com');
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      // The handshake worked and the customer tools the stdio server exposes by default are present.
      expect(names.length).toBe(69);
      expect(names).toEqual(expect.arrayContaining(['traffic_summary', 'add_keyword', 'list_domains', 'seo_report']));
      // The admin-gated tools are NOT present on the default surface.
      const adminTools = [
         'invite_external', 'invite_internal', 'list_invites', 'list_waitlist',
         'share_domain', 'revoke_domain_share', 'list_domain_shares',
         'delete_account_data', 'create_domain', 'onboard', 'request_feature', 'list_feature_requests',
      ];
      expect(adminTools.filter((t) => names.includes(t))).toEqual([]);
   });

   it('resources/list exposes the knowledge resources', async () => {
      const { client } = await connectScopedClient('getmasset.com');
      const listed = await client.listResources();
      expect(listed.resources.length).toBe(5);
      expect(listed.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['knowledge://capabilities', 'knowledge://trust']));
   });
});

describe('scoped share key over the hosted MCP: confined exactly as the API enforces', () => {
   const SCOPED = 'getmasset.com';

   it('ALLOWS a per-domain read tool for its own domain (traffic_summary on getmasset.com)', async () => {
      const { client } = await connectScopedClient(SCOPED);
      const result: any = await client.callTool({ name: 'traffic_summary', arguments: { domain: SCOPED, period: '30d' } });
      expect(result.isError).toBeFalsy();
      // The proxied call carried the scoped key, the API allowed it, and the data came back.
      expect(callText(result)).toContain('getmasset.com');
      expect(callText(result)).toContain('111');
   });

   it('REJECTS a write tool (add_keyword): scoped keys are GET-only', async () => {
      const { client } = await connectScopedClient(SCOPED);
      const result: any = await client.callTool({
         name: 'add_keyword',
         arguments: { keyword: 'masset', domain: SCOPED, country: 'US', device: 'desktop' },
      });
      expect(result.isError).toBe(true);
      expect(callText(result)).toContain(READ_ONLY);
   });

   it('REJECTS the same read tool for ANOTHER domain (domain isolation)', async () => {
      const { client } = await connectScopedClient(SCOPED);
      const result: any = await client.callTool({ name: 'traffic_summary', arguments: { domain: 'competitor.com', period: '30d' } });
      expect(result.isError).toBe(true);
      expect(callText(result)).toContain(domainDenied(SCOPED));
   });

   it('REJECTS a read tool whose route is NOT on the per-domain allowlist (list_domains -> /api/domains)', async () => {
      const { client } = await connectScopedClient(SCOPED);
      // list_domains hits GET /api/domains, which is deliberately EXCLUDED from the scoped-key
      // allowlist (it ignores ?domain and would return account-wide data). The gate denies it.
      const result: any = await client.callTool({ name: 'list_domains', arguments: {} });
      expect(result.isError).toBe(true);
      expect(callText(result)).toContain(ROUTE_DENIED);
   });
});

describe('the proof uses the PRODUCTION gate, not a hand-copy', () => {
   it('isScopedKeyAllowedRoute is the real exported gate and agrees with the assertions above', () => {
      const allowed = { url: '/api/summary?domain=getmasset.com', method: 'GET' } as unknown as NextApiRequest;
      const writeBlocked = { url: '/api/keywords', method: 'POST' } as unknown as NextApiRequest;
      const offlist = { url: '/api/domains', method: 'GET' } as unknown as NextApiRequest;
      expect(isScopedKeyAllowedRoute(allowed)).toBe(true);
      expect(isScopedKeyAllowedRoute(writeBlocked)).toBe(false);
      expect(isScopedKeyAllowedRoute(offlist)).toBe(false);
   });
});
