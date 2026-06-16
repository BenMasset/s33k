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
   const fwdProto = req.headers['x-forwarded-proto'] as string | undefined;
   const fwdHost = req.headers['x-forwarded-host'] as string | undefined;
   const host = fwdHost || req.headers.host || 'localhost:3000';
   const proto = fwdProto || (host.includes('localhost:') ? 'http' : 'https');
   return `${proto}://${host}`.replace(/\/$/, '');
};

export default resolveBaseUrl;
