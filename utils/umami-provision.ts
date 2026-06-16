/**
 * Per-domain Umami website provisioning.
 *
 * For multi-tenant hosting each customer domain needs its OWN Umami website so its
 * analytics are isolated, rather than sharing the single fixed UMAMI_WEBSITE_ID env
 * (which today points at getmasset.com). This module creates a Umami website for a
 * domain via the Umami REST API and returns its website id, which the onboard flow
 * stamps onto Domain.umami_website_id.
 *
 * Implemented against the official Umami v2/v3 REST API (https://docs.umami.is/docs/api):
 *   - Auth (self-hosted): POST /api/auth/login with { username, password } returns
 *       { token }. The token is sent as `Authorization: Bearer <token>`. We reuse the
 *       exact auth flow from utils/umami.ts (getToken), which also honors a pre-issued
 *       UMAMI_API_KEY bearer token.
 *   - Create website: POST /api/websites with { name, domain } returns the created
 *       website object { id, name, domain, ... }. We read `id` back as a string.
 *
 * Configuration (read at runtime, never committed):
 *   UMAMI_BASE_URL   Base URL of the self-hosted Umami instance (required).
 *   UMAMI_API_KEY    Pre-issued bearer token (optional; preferred when set).
 *   UMAMI_USERNAME   Username for POST /api/auth/login (used when no API key).
 *   UMAMI_PASSWORD   Password for POST /api/auth/login (used when no API key).
 *
 * Never throws: returns { websiteId: null, error: <message> } on any config, auth,
 * network, or HTTP failure so the onboard orchestration degrades gracefully (rankings
 * can still proceed without analytics provisioned).
 */

import { normalizeBaseUrl, getToken } from './umami';

/**
 * Create a Umami website for a domain and return its website id.
 *
 * Request shape (POST {UMAMI_BASE_URL}/api/websites):
 *   headers: { Authorization: Bearer <token>, Content-Type: application/json }
 *   body:    { name: <name>, domain: <bareDomain> }
 * The bare domain is normalized (no scheme, no www, no path) so it matches what the
 * Umami tracker reports and what resolveWebsiteId looks up by.
 * @param {string} domain - Site domain, e.g. "getmasset.com".
 * @param {string} [name] - Display name for the Umami website. Defaults to the domain.
 * @returns {Promise<{ websiteId: string | null, error: string | null }>}
 */
export const createUmamiWebsite = async (
   domain: string,
   name?: string,
): Promise<{ websiteId: string | null, error: string | null }> => {
   const bareDomain = String(domain || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
   if (!bareDomain) { return { websiteId: null, error: 'A valid domain is required to provision Umami.' }; }

   const rawBase = process.env.UMAMI_BASE_URL;
   if (!rawBase) { return { websiteId: null, error: 'Analytics provider umami is not configured' }; }
   const base = normalizeBaseUrl(rawBase);

   const { token, error: tokenError } = await getToken(base);
   if (!token) { return { websiteId: null, error: tokenError || 'Umami auth failed.' }; }

   const websiteName = String(name || bareDomain).trim() || bareDomain;
   try {
      const res = await fetch(`${base}/api/websites`, {
         method: 'POST',
         headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
         },
         body: JSON.stringify({ name: websiteName, domain: bareDomain }),
      });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { websiteId: null, error: `Umami website create failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      // Umami returns the created website object; the id may sit at the top level
      // or (on some versions) nested under `data`.
      const created = json?.data && typeof json.data === 'object' ? json.data : json;
      const websiteId = created?.id ? String(created.id) : '';
      if (!websiteId) { return { websiteId: null, error: 'Umami website create returned no id.' }; }
      return { websiteId, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { websiteId: null, error: `Umami website create error: ${message}` };
   }
};

/**
 * Best-effort delete of a Umami website by its website id.
 *
 * Used by the account hard-delete flow to deprovision each per-domain Umami website
 * (Domain.umami_website_id) when a tenant erases their account. Reuses the exact auth
 * flow from utils/umami.ts (getToken), the same one createUmamiWebsite uses.
 *
 * Request shape (DELETE {UMAMI_BASE_URL}/api/websites/:websiteId):
 *   headers: { Authorization: Bearer <token> }
 *
 * NEVER throws: returns { deleted: false, error: <message> } on any config, auth,
 * network, or HTTP failure so the irreversible account delete is never blocked by an
 * analytics-provider hiccup. The s33k DB rows are the source of truth; a stranded Umami
 * website is a tolerable, loggable leftover, not a reason to abort the user's deletion.
 * @param {string} websiteId - The Umami website id (UUID) to delete.
 * @returns {Promise<{ deleted: boolean, error: string | null }>}
 */
export const deleteUmamiWebsite = async (
   websiteId: string,
): Promise<{ deleted: boolean, error: string | null }> => {
   const id = String(websiteId || '').trim();
   if (!id) { return { deleted: false, error: 'A website id is required to delete a Umami website.' }; }

   const rawBase = process.env.UMAMI_BASE_URL;
   if (!rawBase) { return { deleted: false, error: 'Analytics provider umami is not configured' }; }
   const base = normalizeBaseUrl(rawBase);

   const { token, error: tokenError } = await getToken(base);
   if (!token) { return { deleted: false, error: tokenError || 'Umami auth failed.' }; }

   try {
      const res = await fetch(`${base}/api/websites/${encodeURIComponent(id)}`, {
         method: 'DELETE',
         headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { deleted: false, error: `Umami website delete failed (${res.status}): ${text || res.statusText}` };
      }
      return { deleted: true, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { deleted: false, error: `Umami website delete error: ${message}` };
   }
};

export default createUmamiWebsite;
