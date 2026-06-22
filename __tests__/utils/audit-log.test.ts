/**
 * Unit tests for the privileged-access audit log (utils/auditLog.ts + database/models/auditLog).
 *
 * Contract:
 *   - recordAudit writes ONE AuditLog row (actor + action + target metadata) when MULTI_TENANT is on.
 *   - recordAudit is a NO-OP when MULTI_TENANT is off (single-tenant install has no cross-tenant
 *     boundary to audit), so it never touches the model and the trail stays empty.
 *   - recordAudit NEVER throws into the caller: an AuditLog.create failure is swallowed (best-effort).
 *
 * The AuditLog model is mocked so this is a pure unit test (no DB).
 */

jest.mock('../../database/models/auditLog', () => ({ __esModule: true, default: { create: jest.fn() } }));

// eslint-disable-next-line import/first
import { recordAudit } from '../../utils/auditLog';
// eslint-disable-next-line import/first
import AuditLogModel from '../../database/models/auditLog';

const mockAuditLog = AuditLogModel as unknown as { create: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   mockAuditLog.create.mockResolvedValue({ ID: 1 });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('recordAudit', () => {
   it('writes a row with actor + action + target metadata when MULTI_TENANT is on', async () => {
      process.env.MULTI_TENANT = 'true';
      await recordAudit({
         actorAccountId: 1,
         actorRole: 'admin',
         action: 'account-key.mint',
         targetAccountId: 7,
         route: '/api/account-key',
      });
      expect(mockAuditLog.create).toHaveBeenCalledTimes(1);
      const row = mockAuditLog.create.mock.calls[0][0];
      expect(row.actor_account_id).toBe(1);
      expect(row.actor_role).toBe('admin');
      expect(row.action).toBe('account-key.mint');
      expect(row.target_account_id).toBe(7);
      expect(row.route).toBe('/api/account-key');
   });

   it('is a NO-OP (no write) when MULTI_TENANT is off', async () => {
      delete process.env.MULTI_TENANT;
      await recordAudit({ actorAccountId: 1, action: 'cron.sweep' });
      expect(mockAuditLog.create).not.toHaveBeenCalled();
   });

   it('never throws when the write fails (best-effort, non-blocking)', async () => {
      process.env.MULTI_TENANT = 'true';
      mockAuditLog.create.mockRejectedValueOnce(new Error('db down'));
      await expect(recordAudit({ actorAccountId: 1, action: 'account.list' })).resolves.toBeUndefined();
   });
});
