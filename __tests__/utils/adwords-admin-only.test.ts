import { allowedApiRoutes, scopedKeyAllowedRoutes } from '../../utils/allowedApiRoutes';

// Audit A12 guard. The Google Ads OAuth route (/api/adwords) is a LEGACY GLOBAL ADMIN integration:
// its consent URL is built client-side, it has no per-domain/owner binding to sign (unlike the
// Search Console signed-state flow), and it stores only global admin credentials in settings.json.
// The chosen A12 fix is to keep it admin-only and DOCUMENT why a signed state does not apply, rather
// than force the GSC pattern onto a flow that carries nothing tenant-sensitive. This test locks in the
// security property that follows from that decision: the route must never become reachable with a
// Bearer API key or a read-only scoped share key. If a future change makes Google Ads per-domain, it
// must move to authorize() + owner-scoped storage + a signed state first, then update this test
// deliberately.
const ADWORDS_ROUTE = '/api/adwords';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

describe('Google Ads OAuth route stays admin-only (audit A12)', () => {
   it('is not reachable with a Bearer API key through allowedApiRoutes (any method)', () => {
      for (const method of METHODS) {
         expect(allowedApiRoutes).not.toContain(`${method}:${ADWORDS_ROUTE}`);
      }
   });

   it('is not reachable with a read-only scoped share key', () => {
      for (const method of METHODS) {
         expect(scopedKeyAllowedRoutes).not.toContain(`${method}:${ADWORDS_ROUTE}`);
      }
   });
});
