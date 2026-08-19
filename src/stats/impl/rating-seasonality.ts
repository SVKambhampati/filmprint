/**
 * S22 — "Your best and worst months."
 *
 * The stat the design spec trusted least, and it was right to. It ships behind a
 * significance test rather than behind a threshold.
 *
 * WHY THE TEST IS NOT OPTIONAL
 *
 * The headline is always "your highest month". But the MAXIMUM of twelve noisy
 * monthly means is a biased estimator by construction: pick the extreme of twelve
 * random draws and it will sit above the true mean even when every month is
 * identical. At 340 films that is 28 per month, and a 0.2-star swing is
 * comfortably inside noise. Any version of this stat without a test on the
 * selected extreme is a confident sentence about nothing.
 *
 * So: shrunk hierarchical monthly means, a permutation test on the RANGE (the
 * quantity actually being selected), and a hard gate on clean-dated entries.
 * Expect this to stay hidden for most users, and be at peace with that.
 */
import type { StatContext } from "../context.ts";
import { shrink, permutationP, shuffle } from "../primitives.ts";
import { SHRINK_K } from "../../hygiene/thresholds.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Clean-dated ratings needed in a month before it is estimated at all. */
export const MONTH_MIN_N = 10;
/** Significance the selected range must clear. */
export const SEASONALITY_ALPHA = 0.05;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type Month = { month: number; label: string; n: number; rawMean: number; shrunkMean: number };

export type RatingSeasonality = {
  months: Month[];
  best: Month | null;
  worst: Month | null;
  /** Range of shrunk monthly means — the statistic actually being selected. */
  range: number;
  /** Permutation p-value for that range. */
  p: number;
  significant: boolean;
  /** Clean-dated, rated entries that fed the estimate. */
  n: number;
  /** Diary entries excluded as backfilled, bulk-imported or placeholder-dated. */
  excluded: number;
};

export function ratingSeasonality(ctx: StatContext): StatResult<RatingSeasonality> {
  const d = computeRatingSeasonality(ctx);

  if (d.months.length < 2 || d.best == null || d.worst == null) {
    return none(
      d,
      `Not enough reliably-dated ratings spread across the calendar to compare months. ` +
        `${d.excluded} of your diary entries were backfilled or bulk-imported, which makes their ` +
        `dates unusable for this.`,
    );
  }

  if (!d.significant) {
    return none(
      d,
      `Your ratings do not move with the calendar. The gap between your best and worst months is ` +
        `${d.range.toFixed(2)} stars, which does not survive testing (p=${d.p.toFixed(2)}) — picking the ` +
        `highest of twelve months finds a gap that size in pure noise. Whatever else drives your ` +
        `ratings, the time of year does not.`,
      { title: "The calendar doesn't move you", tone: "neutral" },
    );
  }

  return strong(
    d,
    `You rate films highest in ${d.best.label} (${d.best.shrunkMean.toFixed(2)}★ across ${d.best.n} films) ` +
      `and lowest in ${d.worst.label} (${d.worst.shrunkMean.toFixed(2)}★ across ${d.worst.n}). ` +
      `A ${d.range.toFixed(2)}-star swing, and unlike most people's it survives testing (p=${d.p.toFixed(3)}).`,
  );
}

function computeRatingSeasonality(ctx: StatContext): RatingSeasonality {
  // Clean-dated only. A backfiller's watched dates cluster on placeholders and
  // would manufacture a January spike out of nothing.
  const usable: { month: number; rating: number }[] = [];
  let excluded = 0;
  for (const e of ctx.summary.diary) {
    if (e.rating == null) continue;
    if (!e.cleanDated || !e.watchedDate) {
      excluded++;
      continue;
    }
    const month = Number.parseInt(e.watchedDate.slice(5, 7), 10) - 1;
    if (month < 0 || month > 11) continue;
    usable.push({ month, rating: e.rating });
  }

  const empty: RatingSeasonality = {
    months: [], best: null, worst: null, range: NaN, p: NaN, significant: false,
    n: usable.length, excluded,
  };
  if (usable.length < 2) return empty;

  const overallMean = usable.reduce((a, x) => a + x.rating, 0) / usable.length;

  const monthlyMeans = (rows: readonly { month: number; rating: number }[]): Map<number, Month> => {
    const buckets = new Map<number, number[]>();
    for (const r of rows) {
      const list = buckets.get(r.month) ?? [];
      list.push(r.rating);
      buckets.set(r.month, list);
    }
    const out = new Map<number, Month>();
    for (const [month, ratings] of buckets) {
      if (ratings.length < MONTH_MIN_N) continue;
      const raw = ratings.reduce((a, x) => a + x, 0) / ratings.length;
      out.set(month, {
        month,
        label: MONTH_NAMES[month]!,
        n: ratings.length,
        rawMean: raw,
        // Shrunk toward the overall mean, so a thin month cannot spike.
        shrunkMean: shrink(raw, ratings.length, overallMean, SHRINK_K),
      });
    }
    return out;
  };

  const months = [...monthlyMeans(usable).values()].sort((a, b) => a.month - b.month);
  if (months.length < 2) return { ...empty, months };

  const byMean = [...months].sort((a, b) => b.shrunkMean - a.shrunkMean);
  const best = byMean[0]!;
  const worst = byMean[byMean.length - 1]!;
  const range = best.shrunkMean - worst.shrunkMean;

  // Permute the MONTH LABELS and recompute the range. This tests the quantity
  // that was actually selected — the extreme of twelve — rather than one
  // pre-chosen month, which is the whole point.
  const monthLabels = usable.map((u) => u.month);
  const ratings = usable.map((u) => u.rating);

  const p = permutationP(
    range,
    (rand) => {
      const shuffled = shuffle([...monthLabels], rand);
      const permuted = ratings.map((rating, i) => ({ month: shuffled[i]!, rating }));
      const ms = [...monthlyMeans(permuted).values()];
      if (ms.length < 2) return 0;
      const means = ms.map((m) => m.shrunkMean);
      return Math.max(...means) - Math.min(...means);
    },
    { iterations: 1000, seed: 31 },
  );

  return {
    months, best, worst, range, p,
    significant: Number.isFinite(p) && p < SEASONALITY_ALPHA,
    n: usable.length, excluded,
  };
}
