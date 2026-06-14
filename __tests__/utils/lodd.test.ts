import { cleanPath } from '../../utils/lodd';

/**
 * Unit tests for the Lodd path-normalization helper used to join analytics rows
 * against s33k keywords by page path. Pure, no network.
 */
describe('cleanPath', () => {
   it('lowercases the path', () => {
      expect(cleanPath('/Compare/Masset-vs-Seismic')).toBe('/compare/masset-vs-seismic');
   });

   it('strips a query string', () => {
      expect(cleanPath('/resources/webmcp?ref=newsletter')).toBe('/resources/webmcp');
      expect(cleanPath('/pricing?a=1&b=2')).toBe('/pricing');
   });

   it('strips a fragment', () => {
      expect(cleanPath('/software#mcp')).toBe('/software');
   });

   it('strips both query string and fragment', () => {
      expect(cleanPath('/Compare/Masset-vs-Seismic/?ref=x#top')).toBe('/compare/masset-vs-seismic');
   });

   it('removes a trailing slash but preserves the root', () => {
      expect(cleanPath('/about/')).toBe('/about');
      expect(cleanPath('/')).toBe('/');
   });

   it('collapses multiple trailing slashes', () => {
      expect(cleanPath('/about///')).toBe('/about');
   });

   it('extracts the pathname from a full URL', () => {
      expect(cleanPath('https://www.getmasset.com/Resources/WebMCP/?ref=x'))
         .toBe('/resources/webmcp');
      expect(cleanPath('http://example.com/')).toBe('/');
      expect(cleanPath('https://example.com')).toBe('/');
   });

   it('returns an empty string for empty input', () => {
      expect(cleanPath('')).toBe('');
   });

   it('trims surrounding whitespace', () => {
      expect(cleanPath('  /Blog/Post  ')).toBe('/blog/post');
   });

   it('normalizes a query-only-after-root url to root', () => {
      expect(cleanPath('/?utm_source=li')).toBe('/');
   });
});
