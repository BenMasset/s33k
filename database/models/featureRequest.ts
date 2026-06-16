import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// FeatureRequest holds a request, captured over MCP, for a capability s33k does NOT yet have.
// It is the storage behind the request_feature flow: a user's LLM, after confirming via the
// help/knowledge layer that a capability genuinely does not exist, submits the request here so
// an admin can review it. The server-side cross-check (crossCheckCapability in utils/knowledge)
// is the safety net: a request that strongly matches an EXISTING capability is pushed back and
// never reaches this table, so it only ever stores genuinely-new asks.
//
// Tenancy: account_id is the requesting account and owner_id mirrors it for scopeWhere parity
// with the rest of the schema (NULL == the legacy single-tenant admin account). matched_capability
// is normally null (an unmatched, stored request); it is retained on the model so a later admin
// triage can annotate which capability a request maps to. This table only matters with
// MULTI_TENANT on for scoping; the request flow itself works with the flag off too.
@Table({
  timestamps: true,
  tableName: 'feature_request',
})

class FeatureRequest extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   // The account that submitted the request.
   @Column({ type: DataType.INTEGER, allowNull: false })
   account_id!: number;

   // Mirrors account_id for tenant scoping parity. NULL == the legacy admin account.
   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;

   // The requested capability, in the user's own words.
   @Column({ type: DataType.TEXT, allowNull: false })
   request!: string;

   // Optional context: why they want it, what they tried.
   @Column({ type: DataType.TEXT, allowNull: true })
   context!: string;

   // 'open' | 'reviewed' | 'planned' | 'declined' | 'shipped'.
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'open' })
   status!: string;

   // The tool name of a capability an admin later judged this request maps to, if any. Stored
   // requests are unmatched (null) by definition; this is for human triage, not the auto-gate.
   @Column({ type: DataType.STRING, allowNull: true })
   matched_capability!: string;
}

export default FeatureRequest;
