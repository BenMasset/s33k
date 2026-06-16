import { Table, Model, Column, DataType, PrimaryKey, Unique } from 'sequelize-typescript';

@Table({
  timestamps: false,
  tableName: 'domain',
})

class Domain extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   // TEXT not STRING so the dialects match (STRING == VARCHAR(255) on Postgres, TEXT on SQLite).
   // A hostname is normally short, but punycode/unicode and long subdomain chains can approach or
   // exceed 255; TEXT removes the edge case. Postgres allows a UNIQUE index on a TEXT column, so
   // the @Unique guarantee that one domain belongs to exactly one account still holds.
   @Unique
   @Column({ type: DataType.TEXT, allowNull: false, defaultValue: true, unique: true })
   domain!: string;

   @Unique
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: true, unique: true })
   slug!: string;

   @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
   keywordCount!: number;

   @Column({ type: DataType.STRING, allowNull: true })
   lastUpdated!: string;

   @Column({ type: DataType.STRING, allowNull: true })
   added!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: JSON.stringify([]) })
   tags!: string;

   @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
   notification!: boolean;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'daily' })
   notification_interval!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   notification_emails!: string;

   @Column({ type: DataType.TEXT, allowNull: true })
   search_console!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   scrape_strategy!: string;

   @Column({ type: DataType.INTEGER, allowNull: true, defaultValue: 0 })
   scrape_pagination_limit!: number;

   @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: false })
   scrape_smart_full_fallback!: boolean;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   subdomain_matching!: string;

   // Multi-tenant ownership. NULL == the legacy single-tenant admin account.
   // Nullable with no default so existing rows keep working unchanged and queries
   // stay byte-for-byte identical while MULTI_TENANT is off.
   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;

   // Per-domain Umami analytics website id (a UUID string). NULL == fall back to the
   // UMAMI_WEBSITE_ID env, so getmasset.com and existing rows stay unchanged. The
   // onboard flow provisions a Umami website per domain and stamps its id here.
   @Column({ type: DataType.STRING, allowNull: true })
   umami_website_id!: string;
}

export default Domain;
