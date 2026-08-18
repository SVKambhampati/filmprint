/**
 * Sample-size gates, defined once.
 *
 * Every stat asks this module whether it is allowed to render. Per-stat guessing
 * is how you end up with six modules independently deciding to hide themselves
 * and a user staring at a blank page.
 */
export const GATES = {
  /** Any stat that describes the shape of the rating distribution. */
  ratingDistribution: 40,
  /** Any comparison of the user against the crowd. */
  crowdComparison: 60,
  /** Any per-person stat: director, cinematographer, composer, actor. */
  perPerson: 150,
  /** Any slicing by month or by year. */
  temporalSlicing: 250,
  /** A subgroup mean may be shown as a NUMBER at or above this size. */
  subgroupMean: 15,
  /** A subgroup may be shown as a NAME ONLY (no mean) at or above this size. */
  subgroupName: 5,
  /** Any lag or seasonality stat, counted in clean-dated entries. */
  cleanDated: 100,
} as const;

export type Gate = keyof typeof GATES;

/** Shrinkage pseudo-count. One value, everywhere. */
export const SHRINK_K = 8;

export type GateResult = { ok: true } | { ok: false; need: number; have: number; gate: Gate };

export function checkGate(gate: Gate, have: number): GateResult {
  const need = GATES[gate];
  return have >= need ? { ok: true } : { ok: false, need, have, gate };
}
