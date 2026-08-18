/**
 * Statistical primitives shared by every stat.
 *
 * Nothing here knows about films. The point is that each hazard called out in
 * the stat spec gets neutralised in exactly one place, so no individual stat
 * can forget to do it.
 */

/**
 * Empirical-Bayes shrinkage of a subgroup mean toward the user's overall mean.
 *
 * This is the single most important function in the file: it is what stops a
 * user who saw two good Westerns from being told Westerns are their genre.
 * `k` is the pseudo-count — the number of observations at which the group mean
 * and the prior get equal weight.
 */
export function shrink(groupMean: number, n: number, priorMean: number, k = 8): number {
  if (n <= 0) return priorMean;
  return (n * groupMean + k * priorMean) / (n + k);
}

/** Shrunk variance. Group variances need the same treatment as group means. */
export function shrinkVariance(groupVar: number, n: number, priorVar: number, k = 8): number {
  if (n <= 1) return priorVar;
  return (n * groupVar + k * priorVar) / (n + k);
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n-1 denominator). */
export function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

/** Linear-interpolated quantile. `q` in [0, 1]. Input need not be sorted. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

// ---------------------------------------------------------------------------
// Entropy
// ---------------------------------------------------------------------------

/**
 * Plug-in Shannon entropy in bits. Do not display a value from this directly —
 * it is biased downward at small n. Use `entropyBits` instead.
 */
export function plugInEntropyBits(counts: readonly number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Miller-Madow bias-corrected Shannon entropy, in bits.
 *
 * The plug-in estimator systematically understates entropy when n is small
 * relative to the number of bins, because you cannot populate 10 rating buckets
 * evenly with 40 observations. Uncorrected, every light user reads as having a
 * "collapsed" rating scale — which is a fact about the sample size, not the
 * person. The correction is (K - 1) / (2n) nats, converted to bits.
 */
export function entropyBits(counts: readonly number[]): number {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  const occupiedBins = counts.filter((c) => c > 0).length;
  const correctionNats = (occupiedBins - 1) / (2 * n);
  return plugInEntropyBits(counts) + correctionNats / Math.LN2;
}

/**
 * Effective number of categories: 2^H where H is in bits (equivalently exp of
 * the nat-entropy). A user with counts [50, 50] has 2.0; [98, 1, 1] has ~1.2.
 */
export function effectiveCategories(counts: readonly number[]): number {
  return 2 ** entropyBits(counts);
}

// ---------------------------------------------------------------------------
// Rank correlation
// ---------------------------------------------------------------------------

/** Counts strict inversions in `ys` via merge sort. O(n log n). */
function countInversions(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const buf = new Array<number>(n);
  let inversions = 0;

  const sort = (lo: number, hi: number): void => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid);
    sort(mid, hi);
    let i = lo;
    let j = mid;
    let k = lo;
    while (i < mid && j < hi) {
      if (ys[i]! <= ys[j]!) {
        buf[k++] = ys[i++]!;
      } else {
        // ys[i] > ys[j], so ys[i..mid) each form an inversion with ys[j].
        inversions += mid - i;
        buf[k++] = ys[j++]!;
      }
    }
    while (i < mid) buf[k++] = ys[i++]!;
    while (j < hi) buf[k++] = ys[j++]!;
    for (let t = lo; t < hi; t++) ys[t] = buf[t]!;
  };

  sort(0, n);
  return inversions;
}

/** Sum of t*(t-1)/2 over runs of equal values in a sorted array. */
function tiedPairs(sorted: readonly number[]): number {
  let total = 0;
  let run = 1;
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === sorted[i - 1]) {
      run++;
    } else {
      if (run > 1) total += (run * (run - 1)) / 2;
      run = 1;
    }
  }
  return total;
}

/**
 * Kendall tau-b — rank correlation with a tie correction.
 *
 * Tau-b rather than Spearman because a user has at most 10 distinct rating
 * values across potentially thousands of films, so ties are not an edge case,
 * they are most of the data. Spearman's tie handling would understate agreement
 * badly here.
 *
 * O(n log n), so it stays usable in the browser for a 15,000-film history.
 * Returns NaN when either variable is constant (tau-b is undefined there).
 */
export function kendallTauB(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new Error("kendallTauB: length mismatch");
  const n = xs.length;
  if (n < 2) return NaN;

  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => (xs[a]! - xs[b]!) || (ys[a]! - ys[b]!));

  const xSorted = idx.map((i) => xs[i]!);
  const yByX = idx.map((i) => ys[i]!);

  const n0 = (n * (n - 1)) / 2;
  const xTie = tiedPairs(xSorted);
  const yTie = tiedPairs([...ys].sort((a, b) => a - b));

  // Pairs tied in BOTH x and y. After the lexicographic sort above, these are
  // adjacent runs, so we can count them in one pass.
  let jointTie = 0;
  let run = 1;
  for (let i = 1; i <= n; i++) {
    if (i < n && xSorted[i] === xSorted[i - 1] && yByX[i] === yByX[i - 1]) {
      run++;
    } else {
      if (run > 1) jointTie += (run * (run - 1)) / 2;
      run = 1;
    }
  }

  const discordant = countInversions([...yByX]);
  const conMinusDis = n0 - xTie - yTie + jointTie - 2 * discordant;

  const denom = Math.sqrt((n0 - xTie) * (n0 - yTie));
  if (denom === 0) return NaN;
  return conMinusDis / denom;
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so a user's stats don't shuffle on reload. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = { point: number; lo: number; hi: number };

/**
 * Percentile bootstrap CI for an arbitrary statistic.
 *
 * Seeded by default: the same history must produce the same interval every
 * time, or users will notice their numbers twitching between reloads.
 */
export function bootstrapCI<T>(
  sample: readonly T[],
  statistic: (resample: readonly T[]) => number,
  { iterations = 2000, alpha = 0.05, seed = 1 } = {},
): Interval {
  const n = sample.length;
  const point = statistic(sample);
  if (n < 2) return { point, lo: NaN, hi: NaN };

  const rand = rng(seed);
  const stats: number[] = [];
  const scratch = new Array<T>(n);
  for (let b = 0; b < iterations; b++) {
    for (let i = 0; i < n; i++) scratch[i] = sample[Math.floor(rand() * n)]!;
    const s = statistic(scratch);
    if (Number.isFinite(s)) stats.push(s);
  }
  if (stats.length === 0) return { point, lo: NaN, hi: NaN };
  return { point, lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2) };
}

/**
 * One-sided permutation test.
 *
 * Required by any stat that reports the *extreme* of many comparisons — the
 * max-month rating gap, the biggest 4.5-vs-5 feature difference. Selecting the
 * largest of twelve noisy draws and reporting it as a finding is how you ship
 * a confident sentence about pure noise.
 *
 * `observed` is the real statistic; `permute` should recompute it on a
 * label-shuffled copy. Returns the share of permutations at least as extreme.
 */
export function permutationP(
  observed: number,
  permute: (rand: () => number) => number,
  { iterations = 2000, seed = 1 } = {},
): number {
  const rand = rng(seed);
  let atLeastAsExtreme = 0;
  let valid = 0;
  for (let i = 0; i < iterations; i++) {
    const s = permute(rand);
    if (!Number.isFinite(s)) continue;
    valid++;
    if (Math.abs(s) >= Math.abs(observed)) atLeastAsExtreme++;
  }
  if (valid === 0) return NaN;
  // +1 smoothing so p is never exactly 0.
  return (atLeastAsExtreme + 1) / (valid + 1);
}

/** Fisher-Yates shuffle in place, using a supplied PRNG. */
export function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}
