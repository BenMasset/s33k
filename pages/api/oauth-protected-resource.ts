import type { NextApiRequest, NextApiResponse } from 'next';
import { authkitEnabled, protectedResourceMetadata } from '../../utils/authkit';

// RFC 9728 protected-resource metadata for the hosted MCP endpoint. Served at
// /.well-known/oauth-protected-resource via the next.config rewrite. PUBLIC (no auth, and therefore
// intentionally NOT in allowedApiRoutes): its only job is to advertise which authorization server
// (AuthKit) protects /api/mcp so a client like normal Claude or ChatGPT can start the OAuth flow. It
// exposes no secrets. 404 when AuthKit is not configured, so an unconfigured / single-tenant install
// shows no trace of OAuth.
export default function handler(req: NextApiRequest, res: NextApiResponse): void {
   if (!authkitEnabled()) {
      res.status(404).json({ error: 'Not found.' });
      return;
   }
   res.setHeader('Cache-Control', 'public, max-age=300');
   res.status(200).json(protectedResourceMetadata());
}
