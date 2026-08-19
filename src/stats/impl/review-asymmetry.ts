/**
 * S13 — "What makes you write."
 *
 * Two separate quantities, deliberately not blended:
 *
 *   review RATE   — of the films you rated in this band, how many did you write
 *                   about at all? This is the interesting one.
 *   review LENGTH — given that you wrote, how much did you write?
 *
 * Length is conditional on having reviewed, so reporting a single "you write more
 * about films you hate" number confuses the two. A user might write rarely but at
 * enormous length about the few films that provoked them, which is a different
 * person from one who writes a line about everything.
 */
import type { StatContext } from "../context.ts";
import { median } from "../primitives.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Reviews needed in a band before its median length is reported. */
export const BAND_MIN_REVIEWS = 8;

export type ReviewBand = {
  label: string;
  lo: number;
  hi: number;
  /** Films rated in this band (the denominator for rate). */
  rated: number;
  reviews: number;
  rate: number;
  medianWords: number | null;
};

export type ReviewAsymmetry = {
  bands: ReviewBand[];
  totalReviews: number;
  overallRate: number;
  /** Bands where median length is comparable, longest first. */
  lengthRanked: ReviewBand[];
  /** Set when one band is written about far more often than another. */
  rateGap: { talkative: ReviewBand; quiet: ReviewBand; ratio: number } | null;
  /** Set when one band is written about at far greater length than another. */
  lengthGap: { longer: ReviewBand; shorter: ReviewBand; ratio: number } | null;
};

/** Ratio worth calling out. */
export const NOTABLE_RATIO = 1.5;

export function reviewAsymmetry(ctx: StatContext): StatResult<ReviewAsymmetry> {
  const d = computeReviewAsymmetry(ctx);

  if (d.totalReviews === 0) {
    return none(d, "You have never written a review. Your ratings are the whole statement.");
  }

  if (d.lengthGap) {
    const longer = d.lengthGap.longer;
    const shorter = d.lengthGap.shorter;
    return strong(
      d,
      `You average ${longer.medianWords} words on films you ${longer.label} and ` +
        `${shorter.medianWords} on films you ${shorter.label} — ` +
        `${d.lengthGap.ratio.toFixed(1)} times as many. ` +
        `You write ${Math.round(d.overallRate * 100)}% of the time overall.`,
    );
  }

  if (d.rateGap) {
    return strong(
      d,
      `What provokes you to write at all is uneven: you review ` +
        `${Math.round(d.rateGap.talkative.rate * 100)}% of the films you ` +
        `${d.rateGap.talkative.label} against ${Math.round(d.rateGap.quiet.rate * 100)}% of the ones ` +
        `you ${d.rateGap.quiet.label}.`,
      { title: "What provokes you to write" },
    );
  }

  return weak(
    d,
    `You have written ${d.totalReviews} reviews, about ${Math.round(d.overallRate * 100)}% of what you ` +
      `rate, and at much the same length whatever you thought of the film. Your writing does not ` +
      `betray your opinion.`,
    { title: "Your writing is even-handed" },
  );
}

function computeReviewAsymmetry(ctx: StatContext): ReviewAsymmetry {
  const defs = [
    { label: "disliked", lo: 0.5, hi: 2 },
    { label: "felt lukewarm about", lo: 2.5, hi: 3.5 },
    { label: "loved", lo: 4, hi: 5 },
  ];

  const reviewsWithRating = ctx.summary.reviews.filter((r) => r.rating != null);

  const bands: ReviewBand[] = defs.map((b) => {
    const rated = ctx.rated.filter((r) => r.rating >= b.lo && r.rating <= b.hi).length;
    const inBand = reviewsWithRating.filter((r) => r.rating! >= b.lo && r.rating! <= b.hi);
    return {
      ...b,
      rated,
      reviews: inBand.length,
      // Rate can exceed 1 in principle: a film reviewed twice (first watch and
      // rewatch) counts twice against one rated film. Clamped for display sanity.
      rate: rated === 0 ? 0 : Math.min(1, inBand.length / rated),
      medianWords: inBand.length >= BAND_MIN_REVIEWS ? Math.round(median(inBand.map((r) => r.wordCount))) : null,
    };
  });

  const totalReviews = ctx.summary.reviews.length;
  const overallRate = ctx.rated.length === 0 ? 0 : Math.min(1, reviewsWithRating.length / ctx.rated.length);

  const lengthRanked = bands
    .filter((b): b is ReviewBand & { medianWords: number } => b.medianWords != null)
    .sort((a, b) => b.medianWords - a.medianWords);

  let lengthGap: ReviewAsymmetry["lengthGap"] = null;
  if (lengthRanked.length >= 2) {
    const longer = lengthRanked[0]!;
    const shorter = lengthRanked[lengthRanked.length - 1]!;
    const ratio = shorter.medianWords! > 0 ? longer.medianWords! / shorter.medianWords! : Infinity;
    if (Number.isFinite(ratio) && ratio >= NOTABLE_RATIO) lengthGap = { longer, shorter, ratio };
  }

  const ratePool = bands.filter((b) => b.rated >= 10);
  let rateGap: ReviewAsymmetry["rateGap"] = null;
  if (ratePool.length >= 2) {
    const sorted = [...ratePool].sort((a, b) => b.rate - a.rate);
    const talkative = sorted[0]!;
    const quiet = sorted[sorted.length - 1]!;
    const ratio = quiet.rate > 0 ? talkative.rate / quiet.rate : Infinity;
    if (Number.isFinite(ratio) && ratio >= NOTABLE_RATIO) rateGap = { talkative, quiet, ratio };
  }

  return { bands, totalReviews, overallRate, lengthRanked, rateGap, lengthGap };
}
