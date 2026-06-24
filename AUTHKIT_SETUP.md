# AuthKit OAuth for the s33k MCP endpoint (normal Claude + ChatGPT connect)

This is what makes s33k connectable from **normal Claude (claude.ai)** and **ChatGPT**. Those consumer
apps only connect to a remote MCP server over **OAuth**, they have no field to paste a static Bearer
key. WorkOS AuthKit is the OAuth authorization server that handles the handshake (DCR, PKCE, discovery).
s33k validates the AuthKit token and maps it to the account that owns the verified email.

Static-key clients (Claude Code, Cursor, Codex) are unaffected and keep using a pasted key.

This whole path is **off** unless `MULTI_TENANT=true` AND `AUTHKIT_DOMAIN` is set, so an unconfigured
or single-tenant install is untouched. To turn it off instantly, unset `AUTHKIT_DOMAIN`.

---

## 1. WorkOS dashboard (one time)

1. Create a free WorkOS account and a project (AuthKit is free up to 1M monthly active users).
2. **Enable AuthKit** and pick sign-in methods (email magic link and/or Google are the simplest for
   non-technical users).
3. Under **Connect / Configuration**, enable **Client ID Metadata Document (CIMD)** (and Dynamic Client
   Registration if shown). This is what lets Claude/ChatGPT self-register, no client id/secret to paste.
4. Add a **Resource Indicator** equal to your MCP resource URL, exactly:
   `https://app.s33k.io/api/mcp` (must match `MCP_RESOURCE_URL` byte for byte). Tokens are then issued
   with `aud` = this value, which s33k verifies.
5. **Include `email` (and `email_verified`) in the ACCESS token claims.** s33k only ever sees the
   access token, not the id token, and it links you to your account by that email. If email is on the
   id token but not the access token, every connection fails with a clear 403 (see Troubleshooting).
6. Copy your **AuthKit domain** (looks like `https://your-app.authkit.app`).

## 2. Environment (Railway `s33k` service)

Set these, then deploy:

```
MULTI_TENANT=true                         # required (OAuth maps to a per-account key)
AUTHKIT_DOMAIN=https://your-app.authkit.app
MCP_RESOURCE_URL=https://app.s33k.io/api/mcp   # optional; defaults to ${NEXT_PUBLIC_APP_URL}/api/mcp
NEXT_PUBLIC_APP_URL=https://app.s33k.io   # must be the real public origin
SECRET=...                                # already set; encrypts the per-account OAuth key at rest
```

A DB migration runs on boot adding two nullable account columns (`workos_user_id`,
`mcp_oauth_key_enc`). It is additive and idempotent.

## 3. Verify the plumbing (before touching a client)

```
# Should return JSON: { resource, authorization_servers: [your AuthKit domain], bearer_methods_supported }
curl https://app.s33k.io/.well-known/oauth-protected-resource

# Should return 401 with a WWW-Authenticate header pointing at the metadata above
curl -i https://app.s33k.io/api/mcp
```

If the first returns 404, AuthKit is not enabled (check `MULTI_TENANT` and `AUTHKIT_DOMAIN`).

## 4. Connect test (the real proof)

**Normal Claude (claude.ai web or desktop app):**
1. Settings (or Customize) > Connectors > Add custom connector.
2. Paste `https://app.s33k.io/api/mcp`, click Add, then Connect.
3. Sign in with **the email you were invited with** (it must match an existing s33k account).
4. Confirm s33k's tools load, then ask "what should I do first?" (it should call `start_here`).

**ChatGPT (Plus/Pro/Business):**
1. Settings > Apps & Connectors > Advanced settings > turn on Developer mode.
2. Create a connector, paste `https://app.s33k.io/api/mcp`, choose **OAuth**, create, authorize with the
   invited email. (Business/Enterprise: an admin may need to allow custom connectors first.)

## 5. How the account link works (and the one gotcha)

- The AuthKit login email is matched to the s33k account that was invited with that email
  (`email_hash`). First connect links the WorkOS user to the account; later connects resolve by the
  WorkOS user id.
- **Gotcha:** if a user signs in to AuthKit with an email that has **no** s33k account, they get a clear
  403 ("s33k is invite-only: connect with the email you were invited with"). That is intended, s33k is
  invite-only. Make sure the tester's AuthKit email equals their invited email.

## 6. Troubleshooting

- **"The authorization token has no email claim" (403):** AuthKit is signing you in fine, but the
  ACCESS token has no `email`. Add `email` (and `email_verified`) to the access-token claims in WorkOS
  (dashboard step 5). This is the most common first-run failure.
- **"No s33k account for this email" (403):** you signed in to AuthKit with an email that has no s33k
  account. s33k is invite-only; connect with the exact email you were invited with.
- **"Invalid or expired authorization token" (401):** the token failed signature / issuer / audience /
  expiry. Confirm `AUTHKIT_DOMAIN` and `MCP_RESOURCE_URL` match the WorkOS dashboard exactly (the
  Resource Indicator must equal `MCP_RESOURCE_URL` byte for byte), then reconnect.
- **/.well-known/oauth-protected-resource returns 404:** AuthKit is not enabled. Check `MULTI_TENANT=true`
  and `AUTHKIT_DOMAIN`.

## 7. Security notes (for the Tyler review after live testing)

- An OAuth connection is resolved to the account's **own** s33k API key (minted once, stored
  cryptr-encrypted at rest). The MCP route then behaves identically to a pasted key, so `authorize()`
  and all tenant scoping are **unchanged**. No new trust path through `authorize()`.
- Tokens are verified against AuthKit's JWKS with strict `issuer` and `audience` (`aud` = the resource),
  so a token minted for a different resource cannot be replayed.
- The loopback fetch stays header-independent (unchanged). The `.well-known` routes are public, expose
  no secrets, and 404 when unconfigured.
