import { allowedApiRoutes, scopedKeyAllowedRoutes } from '../../utils/allowedApiRoutes';

// These routes still use legacy verifyUser() because they are global/admin maintenance surfaces:
// settings.json, scraper queue maintenance, local migration runner, Google Ads global credentials,
// and cookie logout. They must not become Bearer-key or share-key reachable by accident. If a future
// change needs tenant access to one of these capabilities, migrate the route to authorize() and add
// owner-scoped storage first, then update this test deliberately.
const LEGACY_ADMIN_ROUTES = [
   '/api/clearfailed',
   '/api/settings',
   '/api/ideas',
   '/api/dbmigrate',
   '/api/adwords',
   '/api/logout',
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

describe('legacy verifyUser routes stay out of API-key allowlists', () => {
   it.each(LEGACY_ADMIN_ROUTES)('%s is not reachable with a Bearer API key through allowedApiRoutes', (route) => {
      for (const method of METHODS) {
         expect(allowedApiRoutes).not.toContain(`${method}:${route}`);
      }
   });

   it.each(LEGACY_ADMIN_ROUTES)('%s is not reachable with a scoped share key', (route) => {
      expect(scopedKeyAllowedRoutes).not.toContain(`GET:${route}`);
   });
});
