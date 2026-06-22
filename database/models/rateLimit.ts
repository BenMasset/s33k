import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// A RateLimit row is ONE fixed-window counter for ONE namespaced key (e.g. 'auth-req-email:a@b.com'
// or 'mcp:<bearer>'), shared across ALL app instances via Postgres. It is the cross-process backing
// store for utils/rate-limit.ts when RATE_LIMIT_BACKEND='postgres'.
//
// WHY this exists: the in-memory limiter in utils/rate-limit.ts is PER PROCESS. Under horizontal
// scaling (N instances behind a load balancer) each instance keeps its own counters, so an effective
// limit of L becomes L*N, and the most safety-critical brake (the per-EMAIL magic-link cap, 3/hour)
// degrades to 3*N login links to a victim's inbox. A Postgres-backed counter makes the window
// authoritative across every instance: one shared row per key, mutated by a single atomic UPSERT, so
// the limit holds no matter how many processes serve the traffic.
//
// Fixed window (not sliding), matching the in-memory limiter: cheapest correct shape, and a flood is
// just as blocked. "key" holds the window start (epoch ms) and the hit count; once the window elapses
// the next hit resets the row to a fresh window of 1. The reset is decided inside the UPSERT's
// ON CONFLICT clause, so the whole check-and-increment is ONE round trip with no read-then-write race.
//
// Column names BYTE-MATCH the create-rate-limit-table migration (Postgres is case-sensitive). The PK
// is the TEXT "key" column (the namespaced bucket key, never an auto-increment id, because the UPSERT
// keys conflict resolution on it). "key" is TEXT (never STRING/VARCHAR(255)) so a long bearer-derived
// key cannot truncate on Postgres while passing on SQLite (the truncation class documented in CLAUDE.md).
// "key" is a reserved word in SQL, so it is always quoted in the raw UPSERT in utils/rate-limit-store.ts.
@Table({
  timestamps: false,
  tableName: 'rate_limit',
})

class RateLimit extends Model {
   // The namespaced bucket key. It is the PRIMARY KEY: each key has exactly one window row, and the
   // atomic UPSERT resolves ON CONFLICT ("key"). TEXT so a long key never truncates on Postgres.
   @PrimaryKey
   @Column({ type: DataType.TEXT, allowNull: false, field: 'key' })
   key!: string;

   // The epoch-ms start of the current fixed window for this key. When (now - window_start) >= the
   // caller's windowMs the window has elapsed and the next hit resets it. BIGINT so epoch ms (a value
   // far past INT4's range) is stored without overflow on Postgres.
   @Column({ type: DataType.BIGINT, allowNull: false, field: 'window_start' })
   window_start!: number;

   // The number of hits accounted in the current window. Reset to 1 by the UPSERT when the window
   // has elapsed, otherwise incremented by 1.
   @Column({ type: DataType.INTEGER, allowNull: false, field: 'count' })
   count!: number;
}

export default RateLimit;
