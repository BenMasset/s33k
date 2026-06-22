import fs from 'fs';
import path from 'path';

/**
 * Static guard for the exact Postgres case-sensitivity bug the CTO gate caught on this change: the
 * encrypt-account-email migration runs RAW SQL against the account table, whose PK column is "ID"
 * (uppercase). Postgres is case-sensitive, so an unquoted `id` folds to lowercase and throws
 * 'column "id" does not exist', which on the fail-loud entrypoint refuses to boot any populated
 * instance. SQLite (the jest DB) is case-insensitive and HIDES it, so a behavioral test cannot catch
 * this; this static text guard can. It asserts the migration never references a bare `id` column in
 * SQL and always quotes "ID".
 *
 * Reads the file as TEXT (no import), so it cannot trip the sequelize/uuid ESM issue.
 */
const MIGRATION = path.resolve(
   __dirname,
   '../../database/migrations/1750147200027-encrypt-account-email.js',
);

describe('encrypt-account-email migration uses the case-correct "ID" PK column in raw SQL', () => {
   const src = fs.readFileSync(MIGRATION, 'utf8');

   it('never references a bare lowercase id column in a SQL clause (Postgres would reject it)', () => {
      // Catch `WHERE id`, `SET id`, `SELECT id,`, ` id ` used as a column in raw SQL. The :id BIND
      // PARAMETER (a colon-prefixed placeholder) is allowed and excluded by requiring no leading colon.
      const badColumnRefs = src.match(/(?<![:"\w])id(?![\w"])\s*(=|,|FROM|WHERE)/gi) || [];
      // Allow none. (The bind param `:id` and the JS property `row.ID` are not matched by this.)
      expect(badColumnRefs).toEqual([]);
   });

   it('quotes the account PK as "ID" in its raw SQL statements', () => {
      expect(src.includes('"ID"')).toBe(true);
      // Every SELECT against account selects the quoted "ID".
      expect(/SELECT\s+"ID"/i.test(src)).toBe(true);
      // Every UPDATE ... WHERE keys on the quoted "ID".
      expect(/WHERE\s+"ID"\s*=/.test(src)).toBe(true);
   });

   it('reads the result row by the uppercase ID key (matching the quoted SELECT column)', () => {
      expect(src.includes('row.ID')).toBe(true);
      expect(src.includes('row.id')).toBe(false);
   });
});
