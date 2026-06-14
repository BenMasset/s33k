import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

@Table({
  timestamps: false,
  tableName: 'crawler_hit',
})

class CrawlerHit extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   id!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   domain!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   bot!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   owner!: string;

   @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
   isAiEngine!: boolean;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   path!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   userAgent!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   hitAt!: string;
}

export default CrawlerHit;
