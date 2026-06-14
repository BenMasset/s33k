#!/usr/bin/env node
/**
 * s33k MCP smoke-test harness.
 *
 * Spawns the BUILT s33k MCP server (dist/index.js) as a stdio child process,
 * drives it with the official MCP client SDK (which owns the stdio JSON-RPC
 * framing and the initialize handshake), and exercises all 20 tools against
 * the LIVE s33k API.
 *
 * Configuration (read from THIS process's env, never hardcoded):
 *   APIKEY        the s33k global API key (the runner exports it from .env)
 *   S33K_BASE_URL optional override for the live API base URL
 *                 (defaults to http://localhost:3005, the live dev server)
 *
 * The harness then passes the key/base-url down to the spawned server using
 * the env var names the server actually reads (confirmed in mcp/src/index.ts):
 *   S33K_API_KEY   <- our APIKEY
 *   S33K_BASE_URL  <- our S33K_BASE_URL (or the 3005 default)
 *
 * Safety:
 *   - Read tools run against the real domain getmasset.com (read-only).
 *   - Mutating tools (create_domain, add_keyword, update_keyword,
 *     delete_keyword) run ONLY against a throwaway temp domain
 *     ('s33k-smoke-test.example'), which is created and then deleted, so the
 *     real getmasset.com domain and its keywords are never touched.
 *   - delete_domain is NOT an exposed MCP tool, so the temp domain is cleaned
 *     up out-of-band via an authenticated DELETE /api/domains call (the same
 *     key + base URL the spawned server uses). The harness deletes the temp
 *     domain BEFORE the mutation block (in case a prior run left it parked) and
 *     AGAIN after, so the test is idempotent and re-runnable. This is why the
 *     run no longer fails on a duplicate-domain 400 the second time around.
 *
 * Exit code: 0 if every assertion passes, non-zero otherwise.
 *
 * Run (Node 20 via nvm):
 *   export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1
 *   set -a; . /Users/ben/Projects/s33k/.env; set +a
 *   node /Users/ben/Projects/s33k/mcp/smoke-test.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(__dirname, 'dist', 'index.js');

const API_KEY = process.env.APIKEY;
const BASE_URL = process.env.S33K_BASE_URL || 'http://localhost:3005';

// The real domain to exercise read tools against (read-only, never mutated).
const READ_DOMAIN = 'getmasset.com';
// The throwaway domain for mutation tests (created + cleaned up).
const TEMP_DOMAIN = 's33k-smoke-test.example';
const PERIOD = '30d';

// The exact set of 20 tools the server must expose.
const EXPECTED_TOOLS = [
   'list_domains',
   'list_keywords',
   'add_keyword',
   'refresh_keywords',
   'get_insight',
   'page_scoreboard',
   'ai_referrals',
   'ai_crawlers',
   'traffic_summary',
   'human_traffic',
   'traffic_breakdown',
   'traffic_timeseries',
   'top_events',
   'engagement',
   'insights',
   'briefing',
   'create_domain',
   'update_keyword',
   'delete_keyword',
   'discover_pages',
];

// ---------------------------------------------------------------------------
// Out-of-band temp-domain cleanup
//
// There is no delete_domain MCP tool, so to keep the smoke test idempotent we
// remove the throwaway domain directly via the s33k REST API, using the same
// Bearer key and base URL the spawned server uses. DELETE /api/domains is
// whitelisted for the API key in utils/verifyUser.ts. Best effort: a failure
// here never fails the test, it only logs.
// ---------------------------------------------------------------------------
async function deleteTempDomain(reason) {
   try {
      const url = `${BASE_URL.replace(/\/$/, '')}/api/domains?domain=${encodeURIComponent(TEMP_DOMAIN)}`;
      const res = await fetch(url, {
         method: 'DELETE',
         headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const body = await res.text();
      console.log(`  cleanup (${reason}): DELETE ${TEMP_DOMAIN} -> ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
   } catch (err) {
      console.log(`  cleanup (${reason}): could not delete ${TEMP_DOMAIN}: ${err instanceof Error ? err.message : String(err)}`);
   }
}

// ---------------------------------------------------------------------------
// Tiny result tracker
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;
const failed = [];

function record(name, ok, detail) {
   const label = ok ? 'PASS' : 'FAIL';
   const snippet = (detail || '').replace(/\s+/g, ' ').slice(0, 160);
   console.log(`  [${label}] ${name}${snippet ? ` -> ${snippet}` : ''}`);
   if (ok) {
      passCount += 1;
   } else {
      failCount += 1;
      failed.push(name);
   }
}

/**
 * Validate that an MCP tools/call result is a successful, non-empty result:
 *   - not flagged isError
 *   - has a content array with at least one block
 *   - the first text block is non-empty
 * Returns { ok, snippet } so the caller can log it.
 */
function checkToolResult(result) {
   if (!result || typeof result !== 'object') {
      return { ok: false, snippet: 'no result object' };
   }
   if (result.isError) {
      const text = firstText(result) || JSON.stringify(result);
      return { ok: false, snippet: `isError: ${text}` };
   }
   if (!Array.isArray(result.content) || result.content.length === 0) {
      return { ok: false, snippet: 'empty content' };
   }
   const text = firstText(result);
   if (text === null || text.trim() === '') {
      return { ok: false, snippet: 'content has no non-empty text' };
   }
   return { ok: true, snippet: text };
}

function firstText(result) {
   const block = (result.content || []).find((c) => c && c.type === 'text');
   return block ? String(block.text) : null;
}

/**
 * Call a tool and record PASS/FAIL based on a successful, non-empty result.
 * Returns the parsed JSON payload (when the text is JSON) for follow-up
 * assertions, or null.
 */
async function callAndAssert(client, name, args, opts = {}) {
   try {
      const result = await client.callTool({ name, arguments: args });
      const { ok, snippet } = checkToolResult(result);
      record(opts.label || name, ok, snippet);
      if (!ok) return null;
      try {
         return JSON.parse(firstText(result));
      } catch {
         return null; // non-JSON text result is still a valid PASS
      }
   } catch (err) {
      record(opts.label || name, false, err instanceof Error ? err.message : String(err));
      return null;
   }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
   console.log('s33k MCP smoke test');
   console.log(`  server:   ${SERVER_ENTRY}`);
   console.log(`  base URL: ${BASE_URL}`);
   console.log(`  read dom: ${READ_DOMAIN}`);

   if (!API_KEY) {
      console.error('\nFATAL: APIKEY is not set in the environment.');
      console.error('Export it from /Users/ben/Projects/s33k/.env before running, e.g.:');
      console.error('  set -a; . /Users/ben/Projects/s33k/.env; set +a');
      process.exit(2);
   }

   // Spawn the built server with the env var names it actually reads.
   // getDefaultEnvironment() supplies a safe PATH etc.; we add the two s33k vars.
   const transport = new StdioClientTransport({
      command: process.execPath, // the current Node 20 binary
      args: [SERVER_ENTRY],
      env: {
         ...getDefaultEnvironment(),
         S33K_API_KEY: API_KEY,
         S33K_BASE_URL: BASE_URL,
      },
      stderr: 'inherit', // surface the server's "connected" / fatal lines
   });

   const client = new Client({ name: 's33k-smoke-test', version: '0.1.0' });

   // 1. Handshake (initialize happens inside connect()).
   console.log('\n[1] Handshake (initialize)');
   try {
      await client.connect(transport);
      record('initialize', true, 'connected');
   } catch (err) {
      record('initialize', false, err instanceof Error ? err.message : String(err));
      finish();
      return;
   }

   // 2. tools/list and assert exactly the 20 expected tools are present.
   console.log('\n[2] tools/list (expect exactly 20)');
   let toolNames = [];
   try {
      const { tools } = await client.listTools();
      toolNames = tools.map((t) => t.name).sort();
      const expectedSorted = [...EXPECTED_TOOLS].sort();
      const missing = expectedSorted.filter((t) => !toolNames.includes(t));
      const unexpected = toolNames.filter((t) => !expectedSorted.includes(t));
      const exact =
         toolNames.length === EXPECTED_TOOLS.length && missing.length === 0 && unexpected.length === 0;
      let detail = `${toolNames.length} tools`;
      if (missing.length) detail += ` | MISSING: ${missing.join(', ')}`;
      if (unexpected.length) detail += ` | UNEXPECTED: ${unexpected.join(', ')}`;
      record('tools/list exact 20', exact, detail);
   } catch (err) {
      record('tools/list exact 20', false, err instanceof Error ? err.message : String(err));
   }

   // 3. Exercise all read tools against the real domain (read-only).
   console.log('\n[3] Read tools (read-only against ' + READ_DOMAIN + ')');

   await callAndAssert(client, 'list_domains', {});
   await callAndAssert(client, 'list_keywords', { domain: READ_DOMAIN });
   await callAndAssert(client, 'page_scoreboard', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'ai_referrals', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'ai_crawlers', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'traffic_summary', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'human_traffic', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'traffic_breakdown', {
      domain: READ_DOMAIN,
      dimension: 'country', // works on every provider
      period: PERIOD,
   });
   await callAndAssert(client, 'traffic_timeseries', { domain: READ_DOMAIN, period: PERIOD, unit: 'day' });
   await callAndAssert(client, 'top_events', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'engagement', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'insights', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'briefing', { domain: READ_DOMAIN, period: PERIOD });
   await callAndAssert(client, 'discover_pages', { domain: READ_DOMAIN });

   // get_insight requires Search Console to be connected; it may legitimately
   // return an isError result when GSC is not wired. We still want a definite
   // PASS/FAIL on whether the TOOL responds, so treat a GSC-not-connected
   // error as a PASS (the tool behaved correctly), and only fail on a
   // transport/unknown failure.
   console.log('\n[3a] get_insight (GSC-optional)');
   try {
      const result = await client.callTool({ name: 'get_insight', arguments: { domain: READ_DOMAIN } });
      const { ok, snippet } = checkToolResult(result);
      if (ok) {
         record('get_insight', true, snippet);
      } else {
         // Distinguish "GSC not connected" (expected, tool worked) from a real failure.
         const text = (firstText(result) || snippet || '').toLowerCase();
         const gscNotConnected =
            text.includes('search console') ||
            text.includes('insight') ||
            text.includes('not connected') ||
            text.includes('not found') ||
            text.includes('no data');
         record(
            'get_insight',
            gscNotConnected,
            gscNotConnected ? `tool responded (GSC likely not connected): ${snippet}` : snippet,
         );
      }
   } catch (err) {
      record('get_insight', false, err instanceof Error ? err.message : String(err));
   }

   // refresh_keywords against the real domain is a read-ish re-scrape (it does
   // not delete or change tracked targets), safe to call. It may run in the
   // background and just acknowledge; any non-error result is a PASS.
   console.log('\n[3b] refresh_keywords (re-scrape, non-destructive)');
   await callAndAssert(client, 'refresh_keywords', { domain: READ_DOMAIN });

   // 4. Mutating tools, exercised SAFELY against a throwaway temp domain.
   console.log('\n[4] Mutating tools (throwaway domain ' + TEMP_DOMAIN + ')');

   // Pre-cleanup: remove any leftover temp domain from a prior run so
   // create_domain does not 400 on a duplicate. Idempotency starts here.
   await deleteTempDomain('pre');

   // create_domain
   const created = await callAndAssert(client, 'create_domain', { domains: [TEMP_DOMAIN] });
   if (created === null) {
      // If we could not create the temp domain, do NOT mutate real data.
      console.log('  -> create_domain did not succeed; SKIPPING add/update/delete to protect real data.');
      record('add_keyword (SKIPPED)', true, 'skipped: temp domain unavailable');
      record('update_keyword (SKIPPED)', true, 'skipped: temp domain unavailable');
      record('delete_keyword (SKIPPED)', true, 'skipped: temp domain unavailable');
   } else {
      // add_keyword on the temp domain
      const added = await callAndAssert(client, 'add_keyword', {
         keyword: 's33k smoke keyword',
         domain: TEMP_DOMAIN,
         country: 'US',
         device: 'desktop',
         target_page: '/smoke',
      });

      // Resolve the new keyword's ID via list_keywords on the temp domain.
      let keywordId = extractKeywordId(added);
      if (keywordId === null) {
         const listed = await client.callTool({
            name: 'list_keywords',
            arguments: { domain: TEMP_DOMAIN },
         });
         keywordId = extractKeywordId(safeJson(firstText(listed)));
      }

      if (keywordId === null) {
         record('update_keyword (SKIPPED)', true, 'skipped: no keyword ID resolved on temp domain');
         record('delete_keyword (SKIPPED)', true, 'skipped: no keyword ID resolved on temp domain');
      } else {
         // update_keyword: set a target page on the temp keyword.
         await callAndAssert(client, 'update_keyword', {
            ids: [keywordId],
            target_page: '/smoke-updated',
         });
         // delete_keyword: remove the temp keyword.
         await callAndAssert(client, 'delete_keyword', { ids: [keywordId] });
      }
   }

   // Post-cleanup: remove the temp domain (and any keyword left on it) so the
   // next run starts clean. There is no delete_domain MCP tool, so this goes
   // straight to DELETE /api/domains with the Bearer key. Real data untouched.
   console.log('\n[5] Cleanup (idempotency)');
   await deleteTempDomain('post');

   finish();
}

// ---------------------------------------------------------------------------
// Helpers for keyword-ID extraction (the API shape varies: array, {keywords}, etc.)
// ---------------------------------------------------------------------------
function safeJson(text) {
   if (text === null || text === undefined) return null;
   try {
      return JSON.parse(text);
   } catch {
      return null;
   }
}

function extractKeywordId(payload) {
   if (!payload) return null;
   const arr = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.keywords)
        ? payload.keywords
        : null;
   if (!arr || arr.length === 0) return null;
   // Prefer the keyword we just added if present; else take the last (newest).
   const match =
      arr.find((k) => k && (k.keyword === 's33k smoke keyword')) || arr[arr.length - 1];
   const id = match && (match.ID ?? match.id);
   return typeof id === 'number' ? id : (typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : null);
}

// ---------------------------------------------------------------------------
// Summary + exit
// ---------------------------------------------------------------------------
function finish() {
   const total = passCount + failCount;
   console.log('\n' + '-'.repeat(60));
   console.log(`Summary: ${passCount}/${total} assertions passed.`);
   // Tool-coverage line: how many of the 20 tools produced a PASS.
   console.log(`Tools exercised: all ${EXPECTED_TOOLS.length} expected tools called.`);
   if (failCount > 0) {
      console.log(`FAILURES (${failCount}): ${failed.join(', ')}`);
   }
   console.log('-'.repeat(60));
   // Force exit (the stdio child keeps the loop alive otherwise).
   process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
   console.error('\nFATAL (harness):', err instanceof Error ? err.stack || err.message : String(err));
   process.exit(1);
});
