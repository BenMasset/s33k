// Parse a period string ("30d" / "24h" / "7d" / "3m") into a start timestamp (ms from epoch).
// Shared by the first-party analytics routes so the window math never diverges. Defaults to 30
// days for anything unparseable.
export const periodStartMs = (period: string, nowMs: number): number => {
   const m = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   if (!m) { return nowMs - 30 * 86400e3; }
   const n = parseInt(m[1], 10);
   const unitMs: Record<string, number> = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 };
   return nowMs - n * (unitMs[m[2].toLowerCase()] || 86400e3);
};
