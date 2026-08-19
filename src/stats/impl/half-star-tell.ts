/**
 * S19 — "The half-star tell."
 *
 * Where a user does and does not reach for half stars. Many people use half steps
 * only above 3, which means their dislike has no resolution: everything bad is
 * a flat 2. Cheap, personal, low hazard, works from 40 films.
 */
import type { StatContext } from "../context.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

export type Band = {
  label: string;
  lo: number;
  hi: number;
  whole: number;
  half: number;
  /** Raw share of ratings in this band that are half steps. For display. */
  halfShare: number;
  /**
   * Share of half steps this band would show if the user rated uniformly.
   *
   * Bands do not hold equal proportions of half values — 0.5-2 holds two of four,
   * 4-5 holds one of three — so comparing raw halfShare across them reports a
   * 33-point gap for a perfectly EVEN rater. That is an artifact of where the
   * band edges fall, not a fact about the person.
   */
  expectedHalfShare: number;
  /** halfShare / expectedHalfShare. 1.0 means exactly as expected. */
  halfLift: number;
};

export type HalfStarTell = {
  bands: Band[];
  /** Half-step values never once used. */
  missingHalves: number[];
  overallHalfShare: number;
  /**
   * Set when the user uses half stars far more in one band than another.
   * `gap` is a difference of lifts; `ratio` is how many times as often, which is
   * the only one of the two that can be phrased as "Nx as often" without lying.
   */
  asymmetry: { generous: Band; sparse: Band; gap: number; ratio: number } | null;
  n: number;
};

const HALF_VALUES = [0.5, 1.5, 2.5, 3.5, 4.5] as const;

/** Difference in half-star LIFT between bands worth calling out. */
export const ASYMMETRY_GAP = 0.25;

export function halfStarTell(ctx: StatContext): StatResult<HalfStarTell> {
  const d = computeHalfStarTell(ctx);
  if (d.n === 0) return none(d, "Nothing rated yet, so there is no rating habit to read.");

  if (d.overallHalfShare < 0.02) {
    return strong(
      d,
      `You never use half stars — ${(d.overallHalfShare * 100).toFixed(0)}% of your ratings land on ` +
        `a whole number. You have a five-point scale, not a ten-point one.`,
      { title: "You don't use half stars" },
    );
  }

  if (d.missingHalves.length > 0) {
    const list = d.missingHalves.map((v) => `${v}★`).join(", ");
    return strong(
      d,
      `You have never given ${list}. You reach for half stars when you are sorting out films you ` +
        `like, and stop bothering when you don't — your dislike has less resolution than your praise.`,
      { title: "Where your half stars stop" },
    );
  }

  if (d.asymmetry) {
    return strong(
      d,
      (Number.isFinite(d.asymmetry.ratio)
        ? `You reach for half stars ${d.asymmetry.ratio.toFixed(1)} times as often on ` +
          `${d.asymmetry.generous.label} films as on ${d.asymmetry.sparse.label} ones`
        : `You reach for half stars on ${d.asymmetry.generous.label} films and never on ` +
          `${d.asymmetry.sparse.label} ones`) +
        `. Part of your scale gets finer grading than the rest.`,
      { title: "Your half stars are uneven" },
    );
  }

  return weak(
    d,
    `You use half stars evenly — ${Math.round(d.overallHalfShare * 100)}% of your ratings, spread ` +
      `across the whole scale. You genuinely have a ten-point scale.`,
    { title: "You use all ten points", tone: "flattering" },
  );
}

function computeHalfStarTell(ctx: StatContext): HalfStarTell {
  const ratings = ctx.rated.map((r) => r.rating);
  const isHalf = (v: number) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9 && Math.abs(v - Math.round(v)) > 1e-9;

  const defs: { label: string; lo: number; hi: number }[] = [
    { label: "disliked", lo: 0.5, hi: 2 },
    { label: "middling", lo: 2.5, hi: 3.5 },
    { label: "loved", lo: 4, hi: 5 },
  ];

  const bands: Band[] = defs.map((b) => {
    const inBand = ratings.filter((r) => r >= b.lo && r <= b.hi);
    const half = inBand.filter(isHalf).length;
    const halfShare = inBand.length === 0 ? 0 : half / inBand.length;

    // Every rating value the band can hold, and how many of them are half steps.
    const possible: number[] = [];
    for (let v = b.lo; v <= b.hi + 1e-9; v += 0.5) possible.push(Math.round(v * 2) / 2);
    const expectedHalfShare = possible.filter(isHalf).length / possible.length;

    return {
      ...b,
      whole: inBand.length - half,
      half,
      halfShare,
      expectedHalfShare,
      halfLift: expectedHalfShare === 0 ? 0 : halfShare / expectedHalfShare,
    };
  });

  const populated = bands.filter((b) => b.whole + b.half >= 10);
  let asymmetry: HalfStarTell["asymmetry"] = null;
  if (populated.length >= 2) {
    // Compare LIFT, not raw share, so band geometry cannot manufacture a finding.
    const sorted = [...populated].sort((a, b) => b.halfLift - a.halfLift);
    const generous = sorted[0]!;
    const sparse = sorted[sorted.length - 1]!;
    const gap = generous.halfLift - sparse.halfLift;
    if (gap >= ASYMMETRY_GAP) {
      // Guard the ratio: a band with zero half stars would divide by zero, and
      // "infinitely more often" is not a sentence we want to render.
      const ratio = sparse.halfLift > 0 ? generous.halfLift / sparse.halfLift : Infinity;
      asymmetry = { generous, sparse, gap, ratio };
    }
  }

  return {
    bands,
    missingHalves: HALF_VALUES.filter((v) => !ratings.includes(v)),
    overallHalfShare: ratings.length === 0 ? 0 : ratings.filter(isHalf).length / ratings.length,
    asymmetry,
    n: ratings.length,
  };
}
