import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// Waitlist holds anyone who wants into s33k but does not have an invite yet. The public
// waitlist endpoint writes rows here (deduped by email); an admin reads the list to decide
// who to send an external invite to. status flips from 'waiting' to 'invited' once an
// invite goes out. This table only matters with MULTI_TENANT on; with the flag off it is
// inert.
@Table({
  timestamps: true,
  tableName: 'waitlist',
})

class Waitlist extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   email!: string;

   @Column({ type: DataType.STRING, allowNull: true })
   domain!: string;

   // TEXT not STRING: a free-text user note can run past 255 chars, which silently overflows
   // VARCHAR(255) on Postgres while passing on SQLite.
   @Column({ type: DataType.TEXT, allowNull: true })
   note!: string;

   // 'waiting' | 'invited'.
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'waiting' })
   status!: string;
}

export default Waitlist;
