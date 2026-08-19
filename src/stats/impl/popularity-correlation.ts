/**
 * S16 — "You like what everyone likes."
 *
 * Rank correlation between the user's rating and how many people have voted on a
 * film. The unflattering read: your favourites are simply the popular ones.
 *
 * Two things make it honest:
 *  - vote_count, never `popularity`. TMDB's popularity is a live value that
 *    changes weekly, so any stat built on it cannot be reproduced next month.
 *  - vote_count is normalised within decade x language cohorts before correlating,
 *    for the same reason as the obscurity ledger: raw counts mostly measure how
 *    recent and how English a film is.
 */
import type { StatContext } from "../context.ts";
import { kendallTauB, mean, variance } from "../primitives.ts";
import { decadeOf, releaseYearOf } from "../util.ts";
import { none, strong, weak, type StatResult } from "../result.ts";
import { COHORT_MIN_N } from "./obscurity-ledger.ts";

/** |tau| at or above this is a relationship worth a headline. */
export const NOTABLE_TAU = 0.15;

export type PopularityCorrelation = {
  /** Kendall tau-b between rating and cohort-normalised log vote count. */
  tau: number;
  n: number;
  /** Films skipped because their cohort was too small to normalise against. */
  skipped: number;
};

export function popularityCorrelation(ctx: StatContext): StatResult<PopularityCorrelation> {
  const d = computePopularityCorrelation(ctx);

  if (d.n < 2 || !Number.isFinite(d.tau)) {
    return none(
      d,
      "Too few of your films sit in a cohort big enough to compare popularity within, so this one " +
        "cannot say anything honest.",
    );
  }

  if (d.tau >= NOTABLE_TAU) {
    return strong(
      d,
      `You like what a lot of people like. Across ${d.n} films, your ratings track how widely seen ` +
        `a film is (tau ${d.tau.toFixed(2)}) — even after correcting for the fact that recent ` +
        `English-language films collect more votes than anything else.`,
    );
  }

  if (d.tau <= -NOTABLE_TAU) {
    return strong(
      d,
      `You rate less-seen films higher. Across ${d.n} films your ratings run against popularity ` +
        `(tau ${d.tau.toFixed(2)}), which is unusual and hard to fake.`,
      { title: "You prefer the road less travelled", tone: "flattering" },
    );
  }

  return weak(
    d,
    `Popularity tells us nothing about your ratings (tau ${d.tau.toFixed(2)} across ${d.n} films). ` +
      `How many people have seen something is genuinely irrelevant to whether you like it.`,
    { title: "Popularity doesn't move you", tone: "neutral" },
  );
}

function computePopularityCorrelation(ctx: StatContext): PopularityCorrelation {
  const key = (r: (typeof ctx.rated)[number]) => {
    const y = releaseYearOf(r.film.releaseDate);
    return `${y == null ? "unknown" : decadeOf(y)}|${r.film.originalLanguage || "??"}`;
  };

  const cohorts = new Map<string, number[]>();
  for (const r of ctx.rated) {
    if (r.film.voteCount <= 0) continue;
    const list = cohorts.get(key(r)) ?? [];
    list.push(Math.log10(r.film.voteCount));
    cohorts.set(key(r), list);
  }

  const stats = new Map<string, { mean: number; sd: number }>();
  for (const [k, logs] of cohorts) {
    if (logs.length < COHORT_MIN_N) continue;
    const v = variance(logs);
    if (!Number.isFinite(v) || v <= 0) continue;
    stats.set(k, { mean: mean(logs), sd: Math.sqrt(v) });
  }

  const ratings: number[] = [];
  const zs: number[] = [];
  let skipped = 0;
  for (const r of ctx.rated) {
    if (r.film.voteCount <= 0) {
      skipped++;
      continue;
    }
    const cs = stats.get(key(r));
    if (!cs) {
      skipped++;
      continue;
    }
    ratings.push(r.rating);
    zs.push((Math.log10(r.film.voteCount) - cs.mean) / cs.sd);
  }

  return { tau: ratings.length >= 2 ? kendallTauB(ratings, zs) : NaN, n: ratings.length, skipped };
}
