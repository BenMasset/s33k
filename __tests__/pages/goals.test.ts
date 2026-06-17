/** goals route: create (ownership-gated), list, delete. */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { create: jest.fn(), findAll: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import handler from '../../pages/api/goals';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockGoal = GoalModel as unknown as { create: jest.Mock, findAll: jest.Mock, destroy: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });
const makeReq = (o: { method: string, body?: unknown, query?: Record<string, string> }): NextApiRequest =>
   ({ method: o.method, body: o.body || {}, query: o.query || {}, headers: {} } as unknown as NextApiRequest);
const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
});

describe('/api/goals', () => {
   it('creates a goal when the caller owns the domain', async () => {
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
      mockGoal.create.mockResolvedValue(row({ ID: 5, name: 'Demo', kind: 'page_reached', match_value: '/thanks' }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com', name: 'Demo', kind: 'page_reached', matchValue: '/thanks' } }), res);
      expect(res.statusCode).toBe(201);
      expect(mockGoal.create).toHaveBeenCalled();
      expect(res.payload.goal.name).toBe('Demo');
   });

   it('403s creating a goal on an unowned domain (no create)', async () => {
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'someoneelse.com', name: 'X', kind: 'event', matchValue: 'form_submit' } }), res);
      expect(res.statusCode).toBe(403);
      expect(mockGoal.create).not.toHaveBeenCalled();
   });

   it('400s when required fields are missing', async () => {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { domain: 'getmasset.com' } }), res);
      expect(res.statusCode).toBe(400);
   });

   it('lists goals for a domain', async () => {
      mockGoal.findAll.mockResolvedValue([row({ ID: 1, name: 'Demo' }), row({ ID: 2, name: 'Signup' })]);
      const res = makeRes();
      await handler(makeReq({ method: 'GET', query: { domain: 'getmasset.com' } }), res);
      expect(res.payload.goals).toHaveLength(2);
   });

   it('deletes a goal by id', async () => {
      mockGoal.destroy.mockResolvedValue(1);
      const res = makeRes();
      await handler(makeReq({ method: 'DELETE', query: { id: '5' } }), res);
      expect(res.payload.removed).toBe(1);
   });
});
