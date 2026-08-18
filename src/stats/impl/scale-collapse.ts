/**
 * H5 — "Your scale has collapsed."
 *
 * How much of a 10-point scale the user actually uses, in bits.
 */
import type { StatContext } from "../context.ts";
import { entropyBits, bootstrapCI, type Interval } from "../primitives.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Letterboxd's ten possible values. */
export const RATING_BUCKETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;
export const MAX_BITS = Math.log2(RATING_BUCKETS.length);

export type ScaleCollapse = {
  /** Bias-corrected entropy in bits. */
  bitsUsed: number;
  maxBits: number;
  ci: Interval;
  histogram: { rating: number; count: number }[];
  /** The single most-used rating. */
  mode: number;
  /** Share of ratings inside mode +/- 0.5. */
  modalBandShare: number;
  /** Ratings the user has never once given. */
  unused: number[];
  n: number;
};

/** A scale is "collapsed" when this much of it goes unused. */
export const COLLAPSE_BITS_LOST = 0.8;

export function scaleCollapse(ctx: StatContext): StatResult<ScaleCollapse> {
  const d = computeScaleCollapse(ctx);

  if (d.n === 0) {
    return none(d, "You haven't rated anything yet, so there's no scale to look at.");
  }

  const bandPct = Math.round(d.modalBandShare * 100);
  const lost = d.maxBits - d.bitsUsed;

  if (lost >= COLLAPSE_BITS_LOST) {
    const unusedNote =
      d.unused.length > 0
        ? ` You have never once given ${d.unused.map((u) => `${u}★`).join(", ")}.`
        : "";
    return strong(
      d,
      `You have a 10-point scale. You are using ${d.bitsUsed.toFixed(1)} bits of it — ` +
        `${bandPct}% of your ratings land within half a star of ${d.mode}★.${unusedNote}`,
    );
  }

  // The registry names this stat for its expected conclusion. When the user does
  // NOT have a collapsed scale, the title and tone both have to be corrected, or
  // the card contradicts itself.
  return weak(
    d,
    `You actually use your scale: ${d.bitsUsed.toFixed(1)} of ${d.maxBits.toFixed(1)} bits, ` +
      `with only ${bandPct}% bunched around ${d.mode}★. Most people are far more compressed.`,
    { title: "You use your whole scale", tone: "flattering" },
  );
}

function computeScaleCollapse(ctx: StatContext): ScaleCollapse {
  const ratings = ctx.rated.map((r) => r.rating);
  const counts = RATING_BUCKETS.map((b) => ratings.filter((r) => r === b).length);

  const histogram = RATING_BUCKETS.map((rating, i) => ({ rating, count: counts[i]! }));
  const maxCount = Math.max(...counts);
  const mode = RATING_BUCKETS[counts.indexOf(maxCount)]!;

  const inBand = ratings.filter((r) => Math.abs(r - mode) <= 0.5).length;

  // The CI is bootstrapped over the ratings themselves, so it widens correctly
  // for small samples rather than implying false precision.
  const raw = bootstrapCI(
    ratings,
    (sample) => entropyBits(RATING_BUCKETS.map((b) => sample.filter((r) => r === b).length)),
    { iterations: 600, seed: 17 },
  );

  // Entropy is bounded above by log2(10), and a user who uses the scale evenly
  // sits AT that boundary. Every resample of such a sample is less uniform and so
  // has lower entropy, which puts the whole percentile interval below the point
  // estimate. Widen to contain it rather than rendering hi < point, which reads
  // as a bug. The same applies at the bottom for a single-value rater.
  const ci: Interval = Number.isFinite(raw.lo)
    ? { point: raw.point, lo: Math.min(raw.lo, raw.point), hi: Math.max(raw.hi, raw.point) }
    : raw;

  return {
    bitsUsed: entropyBits(counts),
    maxBits: MAX_BITS,
    ci,
    histogram,
    mode,
    modalBandShare: ratings.length === 0 ? NaN : inBand / ratings.length,
    unused: RATING_BUCKETS.filter((_, i) => counts[i] === 0),
    n: ratings.length,
  };
}
