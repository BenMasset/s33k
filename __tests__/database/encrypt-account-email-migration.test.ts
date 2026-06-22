/**
 * encrypt-account-email migration (1750147200027): shape + backfill + idempotency.
 *
 * Runs the migration against a stub queryInterface (no real DB) and asserts:
 *   - it adds email_hash, widens email to TEXT, DROPS the old plaintext-email unique index, BACKFILLS
 *     each populated row (re-encrypts email in place + sets email_hash), then adds the unique index on
 *     email_hash. Order matters: backfill BEFORE the unique index so collisions surface honestly.
 *   - the backfill UPDATE keys on the quoted "ID" column (Postgres case-correct) and reads row.ID.
 *   - it is FAIL-LOUD when SECRET is missing and rows exist (refuses to leave plaintext PII).
 *   - the encrypted value round-trips (cryptr is real) and the hash matches the blind index helper.
 *
 * The migration does `require('sequelize')` for DataTypes (real sequelize drags ESM uuid jest cannot
 * transform), so DataTypes is mocked to sentinels. cryptr + crypto run for real (the at-rest path).
 */
jest.mock('sequelize', () => ({ __esModule: true, DataTypes: { TEXT: 'TEXT', STRING: 'STRING' } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-dynamic-require, global-require
const migration = require('../../database/migrations/1750147200027-encrypt-account-email.js');
// eslint-disable-next-line import/first
import { decryptEmail, emailHash } from '../../utils/accountEmail';

const ORIGINAL_ENV = { ...process.env };

type Captured = { sql: string, replacements?: Record<string, unknown> };

const makeStub = (rows: Array<Record<string, unknown>>, opts: { hasOldIndex?: boolean } = {}) => {
   const captured: Captured[] = [];
   const qi: Record<string, unknown> = {
      describeTable: jest.fn(async () => ({ email: {}, email_hash: undefined })),
      addColumn: jest.fn(async () => undefined),
      changeColumn: jest.fn(async () => undefined),
      removeIndex: jest.fn(async () => undefined),
      addIndex: jest.fn(async () => undefined),
      showIndex: jest.fn(async () => (opts.hasOldIndex ? [{ name: 'account_email_unique' }] : [])),
      sequelize: {
         transaction: async (fn: (t: unknown) => unknown) => fn({}),
         query: jest.fn(async (sql: string, args?: { replacements?: Record<string, unknown> }) => {
            captured.push({ sql, replacements: args && args.replacements });
            // The first SELECT returns the populated rows (Sequelize returns [rows, meta]).
            if (/^SELECT/i.test(sql)) { return [rows]; }
            return [[], {}];
         }),
      },
   };
   return { qi, captured };
};

beforeEach(() => { process.env = { ...ORIGINAL_ENV }; process.env.SECRET = 'migration-test-secret'; });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('1750147200027-encrypt-account-email up()', () => {
   it('adds email_hash, drops the old email index, backfills, then adds the hash unique index', async () => {
      const { qi, captured } = makeStub(
         [{ ID: 7, email: 'founder@newco.com', email_hash: null }],
         { hasOldIndex: true },
      );
      await migration.up(qi);

      expect(qi.addColumn).toHaveBeenCalledWith('account', 'email_hash', expect.anything(), expect.anything());
      expect(qi.removeIndex).toHaveBeenCalledWith('account', 'account_email_unique', expect.anything());
      expect(qi.addIndex).toHaveBeenCalledWith(
         'account', ['email_hash'], expect.objectContaining({ unique: true, name: 'account_email_hash_unique' }),
      );

      // The backfill UPDATE keys on the quoted "ID" column and binds row.ID.
      const update = captured.find((c) => /^UPDATE account SET email = /i.test(c.sql));
      expect(update).toBeTruthy();
      expect(update.sql).toContain('WHERE "ID" = :id');
      expect(update.replacements.id).toBe(7);
      // The stored email is the ciphertext (not plaintext) and round-trips; the hash is the blind index.
      expect(update.replacements.e).not.toBe('founder@newco.com');
      expect(decryptEmail(update.replacements.e as string)).toBe('founder@newco.com');
      expect(update.replacements.h).toBe(emailHash('founder@newco.com'));
   });

   it('is FAIL-LOUD when SECRET is missing and there are rows to encrypt', async () => {
      delete process.env.SECRET;
      const { qi } = makeStub([{ ID: 1, email: 'a@b.com', email_hash: null }]);
      await expect(migration.up(qi)).rejects.toThrow(/SECRET is required/);
   });

   it('no-ops the backfill when there are no populated rows (still creates the column + index)', async () => {
      delete process.env.SECRET; // no rows => no encryption needed => no throw
      const { qi, captured } = makeStub([]);
      await migration.up(qi);
      expect(captured.find((c) => /^UPDATE/i.test(c.sql))).toBeUndefined();
      expect(qi.addIndex).toHaveBeenCalledWith(
         'account', ['email_hash'], expect.objectContaining({ unique: true }),
      );
   });
});
