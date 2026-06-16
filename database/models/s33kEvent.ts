import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// s33k_event stores ONE row per autocaptured engagement event from the s33k.js client
// script running on a customer site. It is the storage behind the GA4-killer autocapture
// feature: one script tag, zero per-element setup, rich engagement captured automatically.
//
// PRIVACY INVARIANT (non-negotiable): this table holds the EVENT, never the PII. We record
// THAT a button was clicked (its visible text + a CSS selector) and THAT a form was
// submitted (its id/name), but never any value typed into an input, textarea, select,
// contenteditable, or password field, and never keystrokes. No cookies, no fingerprinting.
// The `session` column is a cookieless, daily-rotating anonymous id; it cannot identify a
// person and cannot be joined across days. The /api/collect ingest strips anything
// PII-shaped as defense-in-depth before a row ever reaches this table.
//
// Tenancy: owner_id is stamped at ingest from the owning Domain's owner, so every read
// surface scopes by owner_id (via scopeWhere) and a tenant only ever sees its own events.
@Table({
  timestamps: false,
  tableName: 's33k_event',
})

class S33kEvent extends Model {
   @PrimaryKey
   @Column({ type: DataType.BIGINT, allowNull: false, primaryKey: true, autoIncrement: true, field: 'id' })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   domain!: string;

   // Stamped from Domain.owner_id at ingest. NULL == the legacy single-tenant admin account,
   // matching how owner_id is stored on domain/keyword while MULTI_TENANT is off.
   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;

   // One of: 'click' | 'form_submit' | 'scroll' | 'engagement' | 'outbound'.
   @Column({ type: DataType.STRING, allowNull: false })
   type!: string;

   // The page path the event happened on, e.g. "/pricing". Query string and hash stripped.
   // TEXT not STRING: long paths, click labels, and deep CSS selector chains can exceed 255 chars,
   // which silently overflows VARCHAR(255) on Postgres while passing on SQLite. TEXT keeps them
   // consistent across dialects.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   page!: string;

   // The element's visible text (clicks), the form id/name (form_submit), or the outbound
   // host (outbound). Sanitized and truncated at ingest. NEVER an input value.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   label!: string;

   // A short CSS selector path for the clicked element (clicks only). Nullable.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   selector!: string;

   // Numeric payload: scroll depth percent (scroll) or active engagement seconds
   // (engagement). NULL for click / form_submit / outbound.
   @Column({ type: DataType.INTEGER, allowNull: true })
   value!: number;

   // Cookieless, daily-rotating anonymous session id. Not a person; not joinable across days.
   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   session!: string;

   // The session's first-touch source: a CLASSIFICATION ('direct' | 'referral' |
   // 'organic-search' | 'ai') or at most the bare referrer HOST. NEVER a full referrer URL
   // with a path or query (those can carry PII), enforced by sanitizeSource at ingest. The
   // client reads document.referrer once per session, classifies it, and carries one value on
   // the batch; it is applied to every event so conversions can be attributed by source.
   @Column({ type: DataType.STRING, allowNull: true, defaultValue: null })
   source!: string | null;

   @Column({ type: DataType.STRING, allowNull: false })
   created!: string;
}

export default S33kEvent;
