/**
 * A13: status-code standardization for the legacy SerpBear settings + clearfailed routes.
 *
 * These two file-backed routes previously returned a 200 SUCCESS status on actual error paths.
 * Corrected here:
 *   - settings.ts: unhandled method -> 405 (was 502); missing body -> 400 (was 200); write
 *     failure -> 500 (was 200).
 *   - clearfailed.ts: write failure -> 500 (was 200). (Its 405 method-mismatch is covered in
 *     route-status-codes.test.ts.)
 *
 * Kept separate from route-status-codes.test.ts because that file mocks pages/api/settings (which
 * refresh.ts imports), and this file needs the REAL settings handler. fs/promises is mocked so the
 * write-failure path can be exercised without touching disk; the scraper stack is mocked because
 * settings.ts imports it transitively (cheerio is untranspiled ESM jest cannot parse).
 */

jest.mock('../../utils/verifyUser', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../scrapers/index', () => ({ __esModule: true, default: [] }));
jest.mock('fs/promises', () => ({
   __esModule: true,
   writeFile: jest.fn(async () => undefined),
   readFile: jest.fn(async () => '{}'),
   rename: jest.fn(async () => undefined),
   stat: jest.fn(async () => ({})),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import verifyUserFn from '../../utils/verifyUser';
// eslint-disable-next-line import/first
import { writeFile } from 'fs/promises';
// eslint-disable-next-line import/first
import settingsHandler from '../../pages/api/settings';

const mockVerifyUser = verifyUserFn as unknown as jest.Mock;
const mockWriteFile = writeFile as unknown as jest.Mock;

const makeReq = (opts: { method?: string, body?: unknown } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body ?? {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockVerifyUser.mockReturnValue('authorized');
   mockWriteFile.mockResolvedValue(undefined);
   process.env.SECRET = process.env.SECRET || 'test-secret-value-1234567890';
});

describe('A13 settings.ts', () => {
   it('PATCH (unhandled method) -> 405, not 502', async () => {
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PATCH' }), res);
      expect(res.statusCode).toBe(405);
   });

   it('PUT with missing body -> 400 (client error, not 200)', async () => {
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PUT', body: {} }), res);
      expect(res.statusCode).toBe(400);
   });

   it('PUT whose write fails -> 500 (server error, not 200)', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));
      const res = makeRes();
      await settingsHandler(makeReq({ method: 'PUT', body: { settings: { scraper_type: 'none' } } }), res);
      expect(res.statusCode).toBe(500);
   });
});

describe('A13 clearfailed.ts', () => {
   // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
   const clearfailedHandler = require('../../pages/api/clearfailed').default;

   it('PUT whose write fails -> 500 (server error, not 200)', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));
      const res = makeRes();
      await clearfailedHandler(makeReq({ method: 'PUT' }), res);
      expect(res.statusCode).toBe(500);
   });
});
