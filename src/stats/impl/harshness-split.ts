/**
 * H1 — "Harsh or contrarian?"
 *
 * Two ORTHOGONAL axes, which is the whole point:
 *
 *   level offset   — are you globally stingy or generous? Needs an external
 *                    anchor (see calibration.ts) because a within-set comparison
 *                    is structurally always zero.
 *   rank agreement — do you ORDER the same films the way the crowd does?
 *                    Scale-free, so correctly computed within-set.
 *
 * A user can be a harsh conformist (rankings match, ratings low), which is the
 * most common and least flattering result: most people who believe they are
 * contrarians are simply mean.
 */
import type { StatContext } from "../context.ts";
import { kendallTauB } from "../primitives.ts";
import { harshness, MIN_VOTE_COUNT, type Harshness } from "../calibration.ts";
import { percentileRanks } from "../util.ts";

export type Quadrant =
  | "harsh conformist"
  | "harsh contrarian"
  | "generous conformist"
  | "generous contrarian";

export type Disagreement = {
  name: string;
  userRating: number;
  crowdRating: number;
  /** User percentile minus crowd percentile, both within this user's film set. */
  rankGap: number;
  posterPath: string | null;
};

export type HarshnessSplit = {
  level: Harshness;
  /** Kendall tau-b between the user's ordering and the crowd's. NaN when undefined. */
  rankAgreement: number;
  quadrant: Quadrant | null;
  /** Largest single-film rank disagreements, most extreme first. */
  disagreements: Disagreement[];
  n: number;
  /** True when there is enough data to claim a quadrant about a person. */
  quadrantTrustworthy: boolean;
};

/** Below this, show the disagreement list but not the quadrant. */
export const QUADRANT_MIN_N = 60;
/** tau-b at or above this counts as agreeing with the crowd's ordering. */
export const CONFORMIST_TAU = 0.3;

export function harshnessSplit(ctx: StatContext): HarshnessSplit {
  const usable = ctx.rated.filter((r) => r.film.voteCount >= MIN_VOTE_COUNT && r.film.voteAverage > 0);

  const level = harshness(
    ctx.rated.map((r) => ({
      rating: r.rating,
      voteAverage: r.film.voteAverage,
      voteCount: r.film.voteCount,
    })),
  );

  const userRatings = usable.map((r) => r.rating);
  const crowdRatings = usable.map((r) => r.film.voteAverage);
  const rankAgreement = usable.length >= 2 ? kendallTauB(userRatings, crowdRatings) : NaN;

  const userPct = percentileRanks(userRatings);
  const crowdPct = percentileRanks(crowdRatings);
  const disagreements: Disagreement[] = usable
    .map((r, i) => ({
      name: r.name,
      userRating: r.rating,
      crowdRating: r.film.voteAverage,
      rankGap: userPct[i]! - crowdPct[i]!,
      posterPath: r.film.posterPath,
    }))
    .sort((a, b) => Math.abs(b.rankGap) - Math.abs(a.rankGap))
    .slice(0, 5);

  const quadrantTrustworthy = usable.length >= QUADRANT_MIN_N && Number.isFinite(rankAgreement) && Number.isFinite(level.offset);

  let quadrant: Quadrant | null = null;
  if (quadrantTrustworthy) {
    const harshSide = level.offset < 0 ? "harsh" : "generous";
    const conformSide = rankAgreement >= CONFORMIST_TAU ? "conformist" : "contrarian";
    quadrant = `${harshSide} ${conformSide}` as Quadrant;
  }

  return { level, rankAgreement, quadrant, disagreements, n: usable.length, quadrantTrustworthy };
}
