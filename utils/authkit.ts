import Cryptr from 'cryptr';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import Account from '../database/models/account';
import ApiKey from '../database/models/apiKey';
import { emailHash } from './accountEmail';
import { generateApiKey, hashApiKey, apiKeyPrefix } from './resolveAccount';
import { isMultiTenantEnabled } from './scope';

// WorkOS AuthKit OAuth for the hosted MCP endpoint.
//
// THE POINT: normal Claude (claude.ai connectors) and ChatGPT (developer-mode connectors) can ONLY
// connect to a remote MCP server over OAuth, they have no field to paste a static `Authorization:
// Bearer <key>`. AuthKit is the OAuth 2.1 authorization server that does the DCR/PKCE/metadata dance
// with those clients. This module is s33k's RESOURCE-SERVER half: it validates the AuthKit access
// token a client presents, maps the verified user to an existing s33k account, and resolves that
// account's own s33k API key so the rest of the MCP route is UNCHANGED.
//
// THE ISOLATION INVARIANT (do not regress): an OAuth connection ends up bound to a real per-account
// s33k API key, exactly the credential a user would have pasted. The MCP route passes that key to the
// loopback REST API, and authorize() does all the scoping as it always has. We deliberately do NOT
// teach authorize() about AuthKit tokens: keeping the change at the edge (token -> account -> the
// account's key) means the security-critical auth seam is byte-for-byte the same as the static-key
// path. An OAuth user is held to exactly what a pasted key would be.
//
// FLAG-GATED + ADDITIVE: the whole OAuth path is inert unless MULTI_TENANT is on AND AUTHKIT_DOMAIN is
// set. With the flag off (self-hosters) or AuthKit unconfigured, the static-Bearer path is the only
// path and behaves exactly as before. The account-linking requires the per-account key table, which
// only exists with MULTI_TENANT on, so OAuth correctly requires it.

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

// The AuthKit domain (issuer + JWKS host). e.g. https://your-app.authkit.app. No trailing slash.
export const authkitDomain = (): string => stripTrailingSlash(process.env.AUTHKIT_DOMAIN || '');

// The public app origin (where the .well-known metadata is served). No trailing slash.
const appUrl = (): string => stripTrailingSlash(process.env.NEXT_PUBLIC_APP_URL || '');

// The MCP server resource URL. This is BOTH the `resource` we advertise in protected-resource metadata
// AND the `aud` we require on every AuthKit token. It MUST match, byte for byte, the Resource Indicator
// configured in the WorkOS dashboard. Defaults to <app-origin>/api/mcp; override with MCP_RESOURCE_URL.
export const mcpResourceUrl = (): string => {
   const explicit = process.env.MCP_RESOURCE_URL;
   if (explicit && explicit.trim()) { return stripTrailingSlash(explicit.trim()); }
   const origin = appUrl();
   return origin ? `${origin}/api/mcp` : '';
};

// The URL of our protected-resource metadata document (served via the next.config rewrite). Clients
// read this from the WWW-Authenticate header to discover the authorization server.
export const resourceMetadataUrl = (): string => `${appUrl()}/.well-known/oauth-protected-resource`;

// OAuth is available only when multi-tenant is on (needs the per-account key table) AND AuthKit is
// configured (issuer + a resolvable resource URL). Used to gate the 401 WWW-Authenticate and the
// .well-known routes, so an unconfigured / single-tenant install is untouched.
export const authkitEnabled = (): boolean => isMultiTenantEnabled() && !!authkitDomain() && !!mcpResourceUrl();

// RFC 9728 protected-resource metadata: tells the MCP client which authorization server (AuthKit) to
// use for this resource, and that the token is presented in the Authorization header.
export const protectedResourceMetadata = (): {
   resource: string,
   authorization_servers: string[],
   bearer_methods_supported: string[],
} => ({
   resource: mcpResourceUrl(),
   authorization_servers: [authkitDomain()],
   bearer_methods_supported: ['header'],
});

// The WWW-Authenticate header value that triggers an MCP client to begin the OAuth flow. The
// resource_metadata pointer is the load-bearing part: it tells the client exactly where our metadata
// lives, so discovery does not depend on the client guessing the well-known path.
export const wwwAuthenticate = (errorDescription = 'Authorization needed'): string => [
   'Bearer error="unauthorized"',
   `error_description="${errorDescription}"`,
   `resource_metadata="${resourceMetadataUrl()}"`,
].join(', ');

// A presented Bearer is an AuthKit JWT (vs a static s33k key) iff it is three base64url segments.
// s33k keys are `s33k_<base62>` with no dots, so this cleanly disambiguates the two paths.
export const looksLikeJwt = (token: string): boolean => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

// Memoize the remote JWKS per host. createRemoteJWKSet caches and rotates keys internally, so it must
// be created once, not per request, or every verification refetches the key set.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const getJwks = (domain: string): ReturnType<typeof createRemoteJWKSet> => {
   const url = `${domain}/oauth2/jwks`;
   let set = jwksByUrl.get(url);
   if (!set) {
      set = createRemoteJWKSet(new URL(url));
      jwksByUrl.set(url, set);
   }
   return set;
};

export type AuthKitIdentity = { sub: string, email: string };

// A token that is VALIDLY SIGNED (passed jose) but is missing a claim we require (sub / email) or
// whose email is not verified. This is distinct from a signature/issuer/audience/expiry failure:
// re-authorizing will not fix a missing claim, so the route turns this into an actionable 403 rather
// than another OAuth challenge. The message is user-facing and tells the operator exactly what to fix.
export class AuthKitClaimError extends Error {}

// Verify an AuthKit access token: signature against AuthKit's JWKS, issuer === AUTHKIT_DOMAIN, and
// audience === our MCP resource URL (so a token minted for a DIFFERENT resource cannot be replayed
// here). Returns the verified user id + email. Throws on any failure; the caller turns that into a 401.
export const verifyAuthKitToken = async (token: string): Promise<AuthKitIdentity> => {
   const domain = authkitDomain();
   const resource = mcpResourceUrl();
   if (!domain || !resource) { throw new Error('AuthKit is not configured.'); }
   const { payload }: { payload: JWTPayload } = await jwtVerify(token, getJwks(domain), {
      issuer: domain,
      audience: resource,
   });
   const sub = typeof payload.sub === 'string' ? payload.sub : '';
   const email = typeof payload.email === 'string' ? payload.email : '';
   // email_verified is honored when present (AuthKit verifies emails, but a false claim is a hard no).
   const emailVerified = (payload as { email_verified?: unknown }).email_verified;
   if (!sub) {
      throw new AuthKitClaimError('The authorization token has no subject claim. Reconnect, and contact support if this persists.');
   }
   if (!email) {
      // The MCP server only ever sees the ACCESS token, so email must be a claim on the access token,
      // not just the id token. This is the most likely first-run misconfiguration.
      throw new AuthKitClaimError('The authorization token has no email claim. In WorkOS, include email in the ACCESS token claims (the MCP server only sees the access token), then reconnect.');
   }
   if (emailVerified === false) {
      throw new AuthKitClaimError('Your email is not verified with your login provider. Verify it, then reconnect.');
   }
   return { sub, email };
};

const secretCryptr = (): Cryptr => {
   const secret = process.env.SECRET;
   if (!secret) { throw new Error('SECRET is required to encrypt the OAuth MCP key.'); }
   return new Cryptr(secret);
};

const encryptSecret = (value: string): string => secretCryptr().encrypt(value);
const decryptSecret = (stored: string): string | null => {
   try { return secretCryptr().decrypt(stored); } catch { return null; }
};

// Is this plaintext key a currently-usable (existing, non-revoked) s33k API key?
const apiKeyUsable = async (key: string): Promise<boolean> => {
   const candidate = await ApiKey.findOne({ where: { key_prefix: apiKeyPrefix(key), revoked_at: null } });
   return !!(candidate && candidate.key_hash === hashApiKey(key));
};

// Return the account's cached OAuth-MCP key, minting (and caching, encrypted) a fresh one if there is
// none or the cached one was revoked. The key is a normal per-account key, so it resolves through
// authorize() to this account with the same scope a pasted key would have.
const getOrMintAccountKey = async (account: Account): Promise<string> => {
   if (account.mcp_oauth_key_enc) {
      const existing = decryptSecret(account.mcp_oauth_key_enc);
      if (existing && await apiKeyUsable(existing)) { return existing; }
   }
   const fullKey = generateApiKey();
   await ApiKey.create({
      account_id: account.ID,
      name: 'oauth-mcp',
      key_prefix: apiKeyPrefix(fullKey),
      key_hash: hashApiKey(fullKey),
   });
   account.mcp_oauth_key_enc = encryptSecret(fullKey);
   await account.save();
   return fullKey;
};

export type AuthKitResolution = { key?: string, error?: string };

// Map a verified AuthKit identity to an existing s33k account and return that account's API key.
//
// Linking: resolve by workos_user_id first (the stable id, set on a prior connect). Otherwise join by
// VERIFIED email (the email_hash blind index): if an account exists for that email, link it to this
// WorkOS user. s33k is invite-only, so the account is expected to already exist (created at invite
// accept). If none exists, we reject with a clear, non-enumerating message rather than auto-creating.
export const resolveAccountKeyForAuthKit = async (identity: AuthKitIdentity): Promise<AuthKitResolution> => {
   const { sub, email } = identity;
   let account = await Account.findOne({ where: { workos_user_id: sub } });

   if (!account) {
      const hash = emailHash(email);
      if (hash) { account = await Account.findOne({ where: { email_hash: hash } }); }
      if (account) {
         // An account exists for this verified email. Link it to this WorkOS user unless it is already
         // linked to a DIFFERENT one (defense: one email, one identity).
         if (account.workos_user_id && account.workos_user_id !== sub) {
            return { error: 'This email is already linked to a different login.' };
         }
         if (!account.workos_user_id) {
            account.workos_user_id = sub;
            try {
               await account.save();
            } catch {
               // Unique-index race (a concurrent first-connect linked the same sub): re-resolve by sub.
               account = await Account.findOne({ where: { workos_user_id: sub } }) || account;
            }
         }
      }
   }

   if (!account) {
      return { error: 'No s33k account for this email. s33k is invite-only: connect with the email you were invited with, or request access at s33k.io.' };
   }
   if (account.status !== 'active') {
      return { error: 'This s33k account is not active.' };
   }

   const key = await getOrMintAccountKey(account);
   return { key };
};
