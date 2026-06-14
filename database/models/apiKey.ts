import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// ApiKey is a per-account Bearer key for the hosted, multi-tenant version of s33k.
// One account can have many keys (rotation, separate keys per MCP client); a key maps
// to exactly one account.
//
// The full key (format `s33k_<random>`) is shown ONCE at creation and never stored in
// clear. We persist only key_prefix (first ~8 chars, for lookup + display) and
// key_hash (SHA-256 of the full key). A leaked DB dump therefore does not leak usable
// keys. The legacy global process.env.APIKEY is separate and continues to resolve to
// the admin account; this table is only consulted for non-legacy keys when
// MULTI_TENANT is on.
@Table({
  timestamps: true,
  tableName: 'api_key',
})

class ApiKey extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.INTEGER, allowNull: false })
   account_id!: number;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   name!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   key_prefix!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   key_hash!: string;

   @Column({ type: DataType.DATE, allowNull: true })
   last_used_at!: Date;

   @Column({ type: DataType.DATE, allowNull: true })
   revoked_at!: Date;
}

export default ApiKey;
