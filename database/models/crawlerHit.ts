import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

@Table({
  timestamps: false,
  tableName: 'crawler_hit',
})

class CrawlerHit extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true, field: 'id' })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   domain!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   bot!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   owner!: string;

   @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
   isAiEngine!: boolean;

   // TEXT not STRING: a request path and especially a full User-Agent routinely exceed 255 chars
   // (modern UAs plus tracking suffixes run 300+), which silently overflows VARCHAR(255) on
   // Postgres while passing on SQLite. TEXT keeps the dialects consistent.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   path!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   userAgent!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   hitAt!: string;
}

export default CrawlerHit;
