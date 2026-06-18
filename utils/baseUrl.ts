import type { NextApiRequest } from 'next';

// Resolve the public base URL of this s33k instance for building user-facing links
// (e.g. the invite-accept page link we email out). Mirrors the precedence used in
// pages/api/adwords.ts: prefer the explicit NEXT_PUBLIC_APP_URL (most reliable behind a
// reverse proxy), then the X-Forwarded-* headers, then req.headers.host. Returns a value
// with any trailing slash stripped. Never throws; falls back to localhost as a last resort.
export const resolveBaseUrl = (req: NextApiRequest): string => {
   const configured = process.env.NEXT_PUBLIC_APP_URL;
   if (configured && configured.trim()) {
      return configured.trim().replace(/\/$/, '');
   }
   // SECURITY (host-header poisoning, audit area 1): when NEXT_PUBLIC_APP_URL is unset we are about
   // to derive the base URL from attacker-controllable Host / X-Forwarded-Host headers, and that
   // value is then baked into emailed invite/share links and the minted mcpConfig.S33K_BASE_URL.
   // In production that is unacceptable: a forged Host could point a victim's MCP client or emailed
   // link at an attacker host. So in production we WARN LOUDLY (mirroring the GSC redirect-URI fix)
   // and prefer the request's own host only as a last resort. Operators MUST set NEXT_PUBLIC_APP_URL
   // in prod; this is the safety net that makes the misconfiguration visible instead of silent.
   if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] NEXT_PUBLIC_APP_URL is unset in production. Falling back to the request'
         + ' Host header to build user-facing links, which is host-header-poisoning exposed. Set'
         + ' NEXT_PUBLIC_APP_URL to your real public URL (see DEPLOY.md) and redeploy.');
   }
   const fwdProto = req.headers['x-forwarded-proto'] as string | undefined;
   const fwdHost = req.headers['x-forwarded-host'] as string | undefined;
   const host = fwdHost || req.headers.host || 'localhost:3000';
   const proto = fwdProto || (host.includes('localhost:') ? 'http' : 'https');
   return `${proto}://${host}`.replace(/\/$/, '');
};

export default resolveBaseUrl;
