/**
 * S3 — "What separates your top two ratings."
 *
 * Compares the user's two highest-populated rating values across a small FIXED
 * feature set and reports the largest standardised gap.
 *
 * Two design decisions worth keeping:
 *
 * 1. It compares the top two POPULATED bands rather than hardcoding 5 vs 4.5. On
 *    a real export the user had 15 films at 4.5 and none at 5, so a hardcoded
 *    version simply never runs. "Your top two" always exists.
 *
 * 2. It is a fishing expedition by construction: with several features and
 *    modest group sizes, something always looks different. The winning gap must
 *    survive a permutation test at a Bonferroni-adjusted threshold, and when
 *    nothing survives the stat SAYS so. "Nothing distinguishes them, the
 *    difference is mood" is both honest and the better sentence.
 */
import type { StatContext } from "../context.ts";
import { mean, variance, permutationP, shuffle } from "../primitives.ts";
import { releaseYearOf } from "../util.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Films needed in EACH band before any comparison is attempted. */
export const BARRIER_MIN_GROUP = 20;
/** Family-wise error rate, split across the features by Bonferroni. */
export const BARRIER_ALPHA = 0.05;

type Feature = { key: string; label: string; of: (r: StatContext["rated"][number]) => number | null };

const FEATURES: Feature[] = [
  { key: "runtime", label: "runtime", of: (r) => r.film.runtime },
  { key: "year", label: "release year", of: (r) => releaseYearOf(r.film.releaseDate) },
  { key: "votes", label: "how widely seen it is", of: (r) => (r.film.voteCount > 0 ? Math.log10(r.film.voteCount) : null) },
  { key: "nonEnglish", label: "being non-English", of: (r) => (r.film.originalLanguage === "en" ? 0 : 1) },
  { key: "franchise", label: "being part of a franchise", of: (r) => (r.film.collectionId != null ? 1 : 0) },
  { key: "crowdScore", label: "the crowd's opinion", of: (r) => (r.film.voteAverage > 0 ? r.film.voteAverage : null) },
];

export type FeatureGap = {
  key: string;
  label: string;
  /** Mean in the higher band minus mean in the lower band. */
  rawGap: number;
  /** Standardised (pooled SD) difference. */
  standardised: number;
  n: { upper: number; lower: number };
};

export type RatingBarrier = {
  upperRating: number | null;
  lowerRating: number | null;
  gaps: FeatureGap[];
  /** The largest |standardised| gap, whether or not it survived testing. */
  best: FeatureGap | null;
  /** Permutation p-value for `best`, uncorrected. */
  p: number;
  /** Bonferroni threshold the p-value had to clear. */
  threshold: number;
  survived: boolean;
  groupSizes: { upper: number; lower: number };
};

export function ratingBarrier(ctx: StatContext): StatResult<RatingBarrier> {
  const d = computeRatingBarrier(ctx);

  if (d.upperRating == null || d.lowerRating == null) {
    return none(
      d,
      `You need at least ${BARRIER_MIN_GROUP} films at each of two rating values before there is ` +
        `anything to compare. Your ratings are not yet concentrated enough.`,
    );
  }

  const pair = `${d.upperRating}★ and ${d.lowerRating}★`;

  if (!d.survived || !d.best) {
    return weak(
      d,
      `Nothing distinguishes your ${pair} films. Across runtime, era, language, franchise and how ` +
        `widely seen they are, no difference survives testing — the gap between them is mood, not ` +
        `anything about the films.`,
      { title: "Nothing separates your top two ratings" },
    );
  }

  const dir = d.best.rawGap > 0 ? "more" : "less";
  // "the only thing" would overclaim: only the WINNING feature is permutation
  // tested, so we cannot assert the others were checked and failed.
  return strong(
    d,
    `The clearest difference between your ${d.upperRating}★ films and your ${d.lowerRating}★ ones is ` +
      `${d.best.label}: the ${d.upperRating}★ films have ${dir} of it ` +
      `(${Math.abs(d.best.standardised).toFixed(2)} standard deviations, ${formatP(d.p)}).`,
  );
}

/** Never render "p=0.000": with 2000 permutations the floor is 1/2001. */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return "p unavailable";
  return p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`;
}

function computeRatingBarrier(ctx: StatContext): RatingBarrier {
  const counts = new Map<number, StatContext["rated"][number][]>();
  for (const r of ctx.rated) {
    const list = counts.get(r.rating) ?? [];
    list.push(r);
    counts.set(r.rating, list);
  }

  // The two highest rating values that BOTH clear the minimum group size.
  const eligible = [...counts.entries()]
    .filter(([, films]) => films.length >= BARRIER_MIN_GROUP)
    .sort((a, b) => b[0] - a[0]);

  const empty: RatingBarrier = {
    upperRating: null, lowerRating: null, gaps: [], best: null,
    p: NaN, threshold: NaN, survived: false, groupSizes: { upper: 0, lower: 0 },
  };
  if (eligible.length < 2) return empty;

  const [[upperRating, upper], [lowerRating, lower]] = [eligible[0]!, eligible[1]!];

  const gaps: FeatureGap[] = [];
  for (const f of FEATURES) {
    const a = upper.map(f.of).filter((v): v is number => v != null);
    const b = lower.map(f.of).filter((v): v is number => v != null);
    if (a.length < BARRIER_MIN_GROUP || b.length < BARRIER_MIN_GROUP) continue;

    const va = variance(a);
    const vb = variance(b);
    const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
    const rawGap = mean(a) - mean(b);
    gaps.push({
      key: f.key,
      label: f.label,
      rawGap,
      standardised: pooled > 0 ? rawGap / pooled : 0,
      n: { upper: a.length, lower: b.length },
    });
  }

  if (gaps.length === 0) return { ...empty, upperRating, lowerRating, groupSizes: { upper: upper.length, lower: lower.length } };

  const best = [...gaps].sort((a, b) => Math.abs(b.standardised) - Math.abs(a.standardised))[0]!;
  const feature = FEATURES.find((f) => f.key === best.key)!;

  // Permutation test on the winning feature: shuffle band labels and recompute.
  const pooledValues = [...upper, ...lower].map(feature.of).filter((v): v is number => v != null);
  const nUpper = upper.map(feature.of).filter((v): v is number => v != null).length;

  const p = permutationP(
    best.standardised,
    (rand) => {
      const shuffled = shuffle([...pooledValues], rand);
      const a = shuffled.slice(0, nUpper);
      const b = shuffled.slice(nUpper);
      const va = variance(a);
      const vb = variance(b);
      const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
      return pooled > 0 ? (mean(a) - mean(b)) / pooled : 0;
    },
    { iterations: 2000, seed: 23 },
  );

  // Bonferroni across the features actually tested, because `best` was selected
  // as the maximum of several comparisons.
  const threshold = BARRIER_ALPHA / gaps.length;

  return {
    upperRating, lowerRating, gaps, best, p, threshold,
    survived: Number.isFinite(p) && p < threshold,
    groupSizes: { upper: upper.length, lower: lower.length },
  };
}
