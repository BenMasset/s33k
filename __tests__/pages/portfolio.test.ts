/**
 * portfolio route: a multi-domain rollup that summarizes EVERY domain on the caller's account at
 * once. Mocks the models; the real keyword-distribution + striking-distance + sessionize logic runs.
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt') } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/portfolio';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const kw = (keyword: string, position: number) => row({ keyword, position, url: '[]', history: '{}' });
const pv = (session: string, source: string, is_bot: boolean, page: string, created: string) =>
   row({ session, source, is_bot, device: 'desktop', country: 'US', page, type: 'pageview', created });

const makeReq = (query: Record<string, string>): NextApiRequest =>
   ({ method: 'GET', query, body: {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const find = (domains: any[], domain: string) => domains.find((d) => d.domain === domain);

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   // Two domains on the account.
   mockDomain.findAll.mockResolvedValue([
      row({ ID: 1, domain: 'getmasset.com' }),
      row({ ID: 2, domain: 'second.com' }),
   ]);
   // Per-domain keyword reads, in the order the route loops the domains.
   // getmasset.com: 4 keywords (pos 2 top3+top10, pos 9 top10, pos 18 striking, pos 0 not-in-top-100).
   // second.com: 1 keyword (pos 5, top10, striking-distance window is 4..30 so it counts).
   mockKeyword.findAll
      .mockResolvedValueOnce([kw('a', 2), kw('b', 9), kw('c', 18), kw('d', 0)])
      .mockResolvedValueOnce([kw('e', 5)]);
   // Per-domain event reads. getmasset.com: A human direct, B human ai, C bot ai.
   // second.com: no events at all.
   mockEvent.findAll
      .mockResolvedValueOnce([
         pv('A', 'direct', false, '/', '2026-06-16T10:00:00Z'),
         pv('B', 'ai', false, '/', '2026-06-16T10:01:00Z'),
         pv('C', 'ai', true, '/', '2026-06-16T10:02:00Z'),
      ])
      .mockResolvedValueOnce([]);
});

describe('GET /api/portfolio', () => {
   it('summarizes every domain on the account with rank distribution, striking count, and traffic', async () => {
      const res = makeRes();
      await handler(makeReq({ period: '30d' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.period).toBe('30d');
      expect(res.payload.domains).toHaveLength(2);

      const masset = find(res.payload.domains, 'getmasset.com');
      expect(masset.keywords).toEqual({ total: 4, inTop3: 1, inTop10: 2, onPageOne: 2, notInTop100: 1 });
      // pos 9 and pos 18 are both in the 4..30 striking window; pos 2 (page one) and pos 0 are not.
      expect(masset.strikingDistanceCount).toBe(2);
      // A (direct human) + B (ai human) = 2 human sessions; B is the one AI session; C is a bot, excluded.
      expect(masset.traffic).toEqual({ humanSessions: 2, aiSessions: 1 });

      const second = find(res.payload.domains, 'second.com');
      expect(second.keywords).toEqual({ total: 1, inTop3: 0, inTop10: 1, onPageOne: 1, notInTop100: 0 });
      expect(second.strikingDistanceCount).toBe(1); // pos 5 is in the striking window
      // No events for this domain, so traffic is null (tracking not wired up / no traffic).
      expect(second.traffic).toBeNull();
   });

   it('sorts domains by tracked-keyword count descending', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      const order = res.payload.domains.map((d: any) => d.domain);
      expect(order).toEqual(['getmasset.com', 'second.com']); // 4 keywords before 1
   });

   it('returns an empty list with a helpful note when the account has no domains', async () => {
      mockDomain.findAll.mockResolvedValue([]);
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.domains).toEqual([]);
      expect(res.payload.note).toMatch(/No domains tracked/i);
   });

   it('defaults the period to 30d when none is supplied', async () => {
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.payload.period).toBe('30d');
   });

   it('401s when the caller is not authorized', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'nope' });
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(401);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      await handler({ method: 'POST', query: {}, body: {}, headers: {} } as unknown as NextApiRequest, res);
      expect(res.statusCode).toBe(405);
   });
});
