import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { create: jest.fn() } }));

// eslint-disable-next-line import/first
import handler from '../../pages/api/crawler-hit';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import CrawlerHitModel from '../../database/models/crawlerHit';

const mockAuthorize = authorize as unknown as jest.Mock;
const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockCrawlerHit = CrawlerHitModel as unknown as { create: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

const makeReq = (body: Record<string, unknown>): NextApiRequest => ({
   method: 'POST',
   body,
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
   process.env = { ...ORIGINAL_ENV, CRAWLER_INGEST_ENABLED: 'true', MULTI_TENANT: 'true' };
   mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: 2 }, error: null });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/crawler-hit', () => {
   it('stores the canonical owned domain, not the raw request variant', async () => {
      mockDomain.findOne.mockResolvedValue({ domain: 'example.com', owner_id: 2 });
      mockCrawlerHit.create.mockResolvedValue({});
      const res = makeRes();

      await handler(makeReq({
         domain: 'https://www.Example.com/path',
         path: '/docs',
         userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
      }), res);

      expect(res.statusCode).toBe(200);
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'example.com', owner_id: 2 });
      expect(mockCrawlerHit.create).toHaveBeenCalledWith(expect.objectContaining({
         domain: 'example.com',
         bot: 'GPTBot',
      }));
   });
});
