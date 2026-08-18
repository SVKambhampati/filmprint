/**
 * Crowd-rating calibration — the external anchor that makes "harshness" mean
 * anything at all.
 *
 * WHY THIS FILE EXISTS
 *
 * The obvious way to measure whether a user is harsh is to compare their
 * ratings to the crowd's on the same films. The obvious way to make the two
 * scales comparable is to percentile-rank both within the user's own film set.
 *
 * Those two ideas are incompatible. Percentile-ranking N films by the user's
 * rating gives a uniform distribution with mean 0.5. Percentile-ranking the
 * SAME N films by TMDB's vote_average also gives a uniform distribution with
 * mean 0.5. The difference is identically zero for every user who has ever
 * lived. Within-set ranking is level-invariant by construction, which is
 * exactly the property that makes it fix the scale mismatch — and exactly the
 * property that destroys the level signal harshness is made of.
 *
 * So harshness needs an anchor outside the user's own set: a mapping from a
 * crowd score to the rating a typical Letterboxd user would give. Then
 *
 *     harshness = (their actual mean) - (predicted mean on THEIR films)
 *
 * The prediction step is what handles selection properly. Someone who only
 * watches great films gets a high predicted mean, so good taste does not get
 * misread as generosity.
 *
 * Rank disagreement (Kendall tau-b) is a separate, orthogonal axis and needs
 * none of this — it is scale-free and correctly computed within-set.
 */

/**
 * PROVISIONAL anchor points: TMDB vote_average -> expected Letterboxd rating.
 *
 * These are seeded from population-level means (Letterboxd's global average
 * sits near 3.2-3.3 / 5; TMDB's near 6.5-6.9 / 10) with a plausible monotone
 * slope through them. They are a starting point, NOT a fitted model.
 *
 * TODO: refit from real paired data before H1 ships a number to anyone. Two
 * routes, in order of preference:
 *   1. Aggregate across consenting users once accounts exist. This is the
 *      honest version and it is the same corpus that would eventually make
 *      "vs. the average user" possible.
 *   2. Failing that, hand-label a few hundred films with their public
 *      Letterboxd average and least-squares a monotone spline through it.
 *
 * Until it is refit, treat the harshness axis as directional only: report the
 * quadrant, never a precise "you rate 0.42 stars below expected".
 */
const ANCHORS: ReadonlyArray<readonly [voteAverage: number, expectedRating: number]> = [
  [2.0, 1.10],
  [3.0, 1.60],
  [4.0, 2.10],
  [5.0, 2.60],
  [6.0, 3.05],
  [6.5, 3.25],
  [7.0, 3.50],
  [7.5, 3.75],
  [8.0, 4.00],
  [8.5, 4.30],
  [9.0, 4.55],
  [10.0, 5.00],
];

export const CALIBRATION_IS_FITTED = false;

/**
 * Expected Letterboxd-scale rating for a given TMDB vote_average, by monotone
 * piecewise-linear interpolation over ANCHORS. Clamped to [0.5, 5].
 */
export function expectedRating(voteAverage: number): number {
  if (!Number.isFinite(voteAverage)) return NaN;
  const first = ANCHORS[0]!;
  const last = ANCHORS[ANCHORS.length - 1]!;
  if (voteAverage <= first[0]) return first[1];
  if (voteAverage >= last[0]) return last[1];

  for (let i = 1; i < ANCHORS.length; i++) {
    const [x1, y1] = ANCHORS[i]!;
    if (voteAverage <= x1) {
      const [x0, y0] = ANCHORS[i - 1]!;
      const t = (voteAverage - x0) / (x1 - x0);
      return clampRating(y0 + t * (y1 - y0));
    }
  }
  return last[1];
}

function clampRating(r: number): number {
  return Math.min(5, Math.max(0.5, r));
}

/** Minimum TMDB vote_count for a crowd average to be worth comparing against. */
export const MIN_VOTE_COUNT = 200;

export type HarshnessInput = {
  rating: number;
  voteAverage: number;
  voteCount: number;
};

export type Harshness = {
  /** actual mean minus predicted mean, in stars. Negative = harsher. */
  offset: number;
  actualMean: number;
  predictedMean: number;
  /** Films that survived the vote_count filter and fed the estimate. */
  n: number;
  /** Films dropped because the crowd average was too noisy to compare against. */
  droppedLowVotes: number;
};

/**
 * Level offset: how much harsher or more generous the user is than a typical
 * rater would be *on the films they actually watched*.
 *
 * Films below MIN_VOTE_COUNT are excluded: a film with 12 TMDB votes has a
 * meaningless average, and including them manufactures fake disagreement for
 * anyone who watches obscure films.
 */
export function harshness(films: readonly HarshnessInput[]): Harshness {
  const usable = films.filter(
    (f) =>
      Number.isFinite(f.rating) &&
      Number.isFinite(f.voteAverage) &&
      f.voteAverage > 0 &&
      f.voteCount >= MIN_VOTE_COUNT,
  );
  const droppedLowVotes = films.length - usable.length;
  const n = usable.length;
  if (n === 0) {
    return { offset: NaN, actualMean: NaN, predictedMean: NaN, n: 0, droppedLowVotes };
  }

  let actual = 0;
  let predicted = 0;
  for (const f of usable) {
    actual += f.rating;
    predicted += expectedRating(f.voteAverage);
  }
  const actualMean = actual / n;
  const predictedMean = predicted / n;
  return { offset: actualMean - predictedMean, actualMean, predictedMean, n, droppedLowVotes };
}
