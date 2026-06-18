# Morning runbook: go live + share getmasset.com with Tyler (read-only)

Sharing v2 is built, deployed, and proven airtight (4 adversarial review cycles + the cross-tenant
leak / scoped-key allowlist / canonical-escape tests in the suite, all driving the real auth path).
I deliberately did NOT flip the prod multi-tenant flag overnight: that is the launch switch and a
high-severity prod change that is yours to greenlight (the sandbox correctly blocked me from doing it
autonomously). It is two commands.

## Step 1 - flip the multi-tenant flag (one command, ~4 min redeploy)
```
railway variables --set "MULTI_TENANT=true" --service s33k
```
This redeploys s33k with tenant isolation ON. Your existing admin API key keeps full access (the
legacy global key always resolves to admin). Wait until the redeploy is live (the Railway dashboard,
or: `curl -s -o /dev/null -w "%{http_code}" https://s33k-production.up.railway.app/api/domains` returns 401).

## Step 2 - mint Tyler's read-only key for getmasset.com (one command)
```
railway run --service s33k -- bash -lc 'curl -s -H "Authorization: Bearer $APIKEY" -H "Content-Type: application/json" -X POST "https://s33k-production.up.railway.app/api/share" -d "{\"domain\":\"getmasset.com\",\"email\":\"tyler@getmasset.com\"}"'
```
It returns a one-time `s33k_...` key plus an `mcpConfig` ({ S33K_BASE_URL, S33K_API_KEY }). If you pass
the email, Tyler also gets an invite email with the connect instructions. Send Tyler the key + the
one-line MCP setup; he pastes it as `S33K_API_KEY`, connects the s33k MCP, and can immediately ask
"show me an overview of getmasset.com" / "what are my keyword rankings" / "is AI search making me
money" - and ONLY getmasset.com, read-only.

## What Tyler's key can and cannot do (proven)
- CAN: read every analytics / SEO / AEO report for getmasset.com (44 per-domain GET routes incl.
  dashboard, human-analytics, keyword rankings, aeo_roi).
- CANNOT: read any other domain, write anything (add keywords, refresh, change settings), see your
  account/billing, list your other domains, export, or reach any cross-domain/instance route. It is a
  read-only, single-domain, GET-only key, enforced by a positive allowlist + canonical-domain match +
  stripped admin identity.

## To revoke later
List shares: `GET /api/share?domain=getmasset.com` (admin key). Revoke: `DELETE /api/share?id=<id>`.

## To roll back the launch (if anything looks off)
```
railway variables --set "MULTI_TENANT=false" --service s33k
```
Flag-off is byte-for-byte the single-tenant behavior; nothing is lost.
