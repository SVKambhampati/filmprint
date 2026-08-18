/** Small helpers shared across stat implementations. */

/** Release year from an ISO date, or null. */
export function releaseYearOf(releaseDate: string | null): number | null {
  if (!releaseDate) return null;
  const y = Number.parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

/** Decade bucket, e.g. 1994 -> 1990. */
export function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * Percentile ranks in [0, 1], averaging ranks within ties.
 *
 * Tie-averaging matters here: a user has at most 10 distinct rating values, so
 * assigning arbitrary within-tie order would invent disagreement that isn't real.
 */
export function percentileRanks(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];

  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const out = new Array<number>(n);

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]!] === values[idx[i]!]) j++;
    // Average rank across the tie group, mapped to [0, 1].
    const avgRank = (i + j) / 2;
    const pct = n === 1 ? 0.5 : avgRank / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k]!] = pct;
    i = j + 1;
  }
  return out;
}
