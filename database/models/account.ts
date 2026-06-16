import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// Account is the billing/ownership unit for the hosted, multi-tenant version of s33k.
// In the common case one account == one company == one human, but the model allows
// many api keys (and later many users) per account.
//
// Seeded with exactly one admin row (ID = 1) which is the home for all legacy
// single-tenant data. A NULL owner_id on domain/keyword and owner_id = 1 are treated
// as equivalent by the scoping helper, so existing rows keep working with zero
// migration. This table only matters once MULTI_TENANT is turned on; with the flag
// off it is inert.
@Table({
  timestamps: true,
  tableName: 'account',
})

class Account extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   name!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'free' })
   plan!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'active' })
   status!: string;

   // How many EXTERNAL invites this account may send (each external invite brings a new
   // admin + account into s33k). The viral lever, bounded so one account cannot flood the
   // system. Internal invites (read-only members on this account) are unlimited and not
   // counted against this. Only meaningful with MULTI_TENANT on.
   @Column({ type: DataType.INTEGER, allowNull: true, defaultValue: 5 })
   external_invite_quota!: number;
}

export default Account;
