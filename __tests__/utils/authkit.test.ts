/**
 * Unit tests for the PURE helpers in utils/authkit.ts: the JWT-vs-static-key discriminator, the
 * env-driven enable gate, the resource/issuer URL derivation, and the metadata + WWW-Authenticate
 * shapes a client uses to discover AuthKit. The token-verification and account-linking paths talk to
 * AuthKit's JWKS and the DB, so they are proven end-to-end by the live connect test in AUTHKIT_SETUP.md
 * rather than mocked here. These pure checks lock the discovery contract and the additive flag gating.
 */

// authkit.ts statically imports the Account/ApiKey sequelize models (used only on the OAuth runtime
// path). Loading the real models pulls sequelize + its ESM esm-browser uuid into jest-jsdom, which
// jest cannot parse. These tests cover only the PURE helpers, which never touch the models, so stub
// them out (the same pattern the resolveAccount unit test uses).
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findOne: jest.fn(), create: jest.fn() } }));

import {
   looksLikeJwt,
   authkitDomain,
   mcpResourceUrl,
   resourceMetadataUrl,
   authkitEnabled,
   protectedResourceMetadata,
   wwwAuthenticate,
} from '../../utils/authkit';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('utils/authkit pure helpers', () => {
   it('looksLikeJwt tells an AuthKit JWT (three segments) from a static s33k key (no dots)', () => {
      expect(looksLikeJwt('s33k_aBc123XYZ')).toBe(false);
      expect(looksLikeJwt('header.payload.signature')).toBe(true);
      expect(looksLikeJwt('aGVhZGVy.cGF5bG9hZA.c2ln')).toBe(true);
      expect(looksLikeJwt('only.two')).toBe(false);
      expect(looksLikeJwt('')).toBe(false);
      expect(looksLikeJwt('not a jwt')).toBe(false);
   });

   it('authkitDomain and mcpResourceUrl strip trailing slashes and default the resource from the app origin', () => {
      process.env.AUTHKIT_DOMAIN = 'https://x.authkit.app/';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.s33k.io/';
      delete process.env.MCP_RESOURCE_URL;
      expect(authkitDomain()).toBe('https://x.authkit.app');
      expect(mcpResourceUrl()).toBe('https://app.s33k.io/api/mcp');
      // An explicit override wins and is also trailing-slash normalized.
      process.env.MCP_RESOURCE_URL = 'https://custom.example.com/api/mcp/';
      expect(mcpResourceUrl()).toBe('https://custom.example.com/api/mcp');
   });

   it('authkitEnabled requires MULTI_TENANT on AND AuthKit configured (additive gate)', () => {
      process.env.AUTHKIT_DOMAIN = 'https://x.authkit.app';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.s33k.io';
      process.env.MULTI_TENANT = 'false';
      expect(authkitEnabled()).toBe(false);
      process.env.MULTI_TENANT = 'true';
      expect(authkitEnabled()).toBe(true);
      delete process.env.AUTHKIT_DOMAIN;
      expect(authkitEnabled()).toBe(false);
   });

   it('protectedResourceMetadata + wwwAuthenticate advertise AuthKit and the metadata pointer', () => {
      process.env.AUTHKIT_DOMAIN = 'https://x.authkit.app';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.s33k.io';
      delete process.env.MCP_RESOURCE_URL;
      const meta = protectedResourceMetadata();
      expect(meta.resource).toBe('https://app.s33k.io/api/mcp');
      expect(meta.authorization_servers).toEqual(['https://x.authkit.app']);
      expect(meta.bearer_methods_supported).toEqual(['header']);
      expect(resourceMetadataUrl()).toBe('https://app.s33k.io/.well-known/oauth-protected-resource');
      const header = wwwAuthenticate('Authorization needed');
      expect(header).toContain('Bearer error="unauthorized"');
      expect(header).toContain('resource_metadata="https://app.s33k.io/.well-known/oauth-protected-resource"');
   });
});
