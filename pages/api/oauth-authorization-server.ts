import type { NextApiRequest, NextApiResponse } from 'next';
import { authkitEnabled, authkitDomain } from '../../utils/authkit';

// Back-compat shim. Some MCP clients look for OAuth authorization-server metadata at the RESOURCE
// origin's /.well-known/oauth-authorization-server instead of following the protected-resource pointer
// to the AuthKit domain. We proxy AuthKit's own document so those clients still discover the
// authorization + token + registration endpoints. PUBLIC, read-only passthrough (no auth, not in
// allowedApiRoutes). 404 when AuthKit is unconfigured.
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
   if (!authkitEnabled()) {
      res.status(404).json({ error: 'Not found.' });
      return;
   }
   try {
      const upstream = await fetch(`${authkitDomain()}/.well-known/oauth-authorization-server`);
      const body = await upstream.json();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(upstream.status).json(body);
   } catch {
      res.status(502).json({ error: 'Failed to fetch authorization server metadata.' });
   }
}
