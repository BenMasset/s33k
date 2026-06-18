import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// Invite is the credential that lets someone into the invite-only, multi-tenant version
// of s33k. There are three kinds:
//   - 'external': brings a brand-new admin + account into s33k. Limited per inviter by
//     the inviter account's external_invite_quota. This is the viral lever.
//   - 'internal': an existing admin adds a read-only teammate (a MEMBER) to their own
//     account. Unlimited; target_account_id is the inviting admin's account.
//   - 'share': a one-time activation link for per-domain READ-ONLY sharing. On accept it
//     mints a read-only key SCOPED to one domain (scoped_domain) on target_account_id (the
//     domain owner's account). The share email carries NO key: the key is minted on accept
//     and shown once, the safer replacement for embedding the key in the email.
//
// The `code` is the actual secret: the public accept endpoint mints a real API key gated
// only by this code, so it must be long, random, single-use, and expirable. It is stored
// in clear (indexed, unique) because it is single-use and short-lived; an invalid code is
// rejected fast and acceptance flips status off 'pending'. This table only matters with
// MULTI_TENANT on; with the flag off it is inert.
@Table({
  timestamps: true,
  tableName: 'invite',
})

class Invite extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   code!: string;

   @Column({ type: DataType.INTEGER, allowNull: false })
   inviter_account_id!: number;

   // 'external' (new admin + account), 'internal' (read-only member on target_account_id), or
   // 'share' (read-only key SCOPED to scoped_domain, minted on target_account_id on accept).
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'external' })
   type!: string;

   @Column({ type: DataType.STRING, allowNull: true })
   email!: string;

   // The account an internal invite joins. Null for external invites (no account yet).
   @Column({ type: DataType.INTEGER, allowNull: true })
   target_account_id!: number;

   // 'pending' | 'accepted' | 'expired' | 'revoked'.
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
   status!: string;

   @Column({ type: DataType.DATE, allowNull: true })
   accepted_at!: Date;

   // The account created (external) or that gained a member seat (internal) on acceptance.
   @Column({ type: DataType.INTEGER, allowNull: true })
   accepted_by_account_id!: number;

   // For a 'share' invite ONLY: the CANONICAL domain the minted key is scoped to. On accept,
   // a read-only member key is created on target_account_id with api_key.scoped_domain set to
   // this value, so authorize() holds it to GET-only on exactly this one domain. Null for
   // external / internal invites. TEXT (not the default VARCHAR(255)) per the prod Postgres
   // widen-to-TEXT convention, byte-matching the migration column. Only meaningful with
   // MULTI_TENANT on.
   @Column({ type: DataType.TEXT, allowNull: true })
   scoped_domain!: string | null;
}

export default Invite;
