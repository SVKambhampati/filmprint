/**
 * S8 — "Where you're certain, where you gamble."
 *
 * The replacement for the commodity "top 5 genres by count", which Letterboxd Pro
 * already shows. Instead of counts, each genre gets a position in two dimensions:
 * shrunk rating LIFT against the user's mean (x) and within-genre rating SPREAD
 * (y). High lift with low spread is a habit; high spread is a search.
 *
 * Two hazards, both handled:
 *  - Genres are multi-label, so a film lands in several buckets. Never normalise
 *    as if exclusive; shares here are per-genre, not shares of a whole.
 *  - Survivorship. You only watch horror you expect to like, so lift measures how
 *    well you PICK within a genre, not innate taste for it. The copy says so.
 */
import type { StatContext } from "../context.ts";
import { shrink, shrinkVariance, mean, variance } from "../primitives.ts";
import { SHRINK_K, GATES } from "../../hygiene/thresholds.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

export type GenreConviction = {
  genres: {
    genre: string;
    n: number;
    lift: number;
    /** Shrunk within-genre standard deviation. */
    spread: number;
  }[];
  /** Highest lift with below-median spread: where the user is confident. */
  mostCertain: { genre: string; lift: number; spread: number } | null;
  /** Highest spread: where the user is gambling. */
  mostVolatile: { genre: string; lift: number; spread: number } | null;
};

export function genreConviction(ctx: StatContext): StatResult<GenreConviction> {
  const d = computeGenreConviction(ctx);

  if (d.genres.length === 0) {
    return none(
      d,
      `No genre has ${GATES.subgroupMean} or more rated films yet, which is the minimum for a ` +
        `spread estimate to mean anything.`,
    );
  }
  if (!d.mostCertain || !d.mostVolatile || d.genres.length < 2) {
    const only = d.genres[0]!;
    return weak(
      d,
      `Only ${d.genres.length} genre has enough films to judge: ${only.genre}, where you rate ` +
        `${only.lift >= 0 ? "above" : "below"} your own average by ${Math.abs(only.lift).toFixed(2)} stars.`,
    );
  }

  return strong(
    d,
    `You are most certain about ${d.mostCertain.genre} and most volatile about ${d.mostVolatile.genre} ` +
      `(spread ${d.mostVolatile.spread.toFixed(2)} against ${d.mostCertain.spread.toFixed(2)} stars). ` +
      `Read that as how well you PICK within a genre rather than how much you like it — you only ` +
      `watch the ${d.mostCertain.genre} you already expect to enjoy.`,
  );
}

function computeGenreConviction(ctx: StatContext): GenreConviction {
  const buckets = new Map<string, number[]>();
  for (const r of ctx.rated) {
    for (const g of ctx.genres.get(r.film.tmdbId) ?? []) {
      const list = buckets.get(g) ?? [];
      list.push(r.rating);
      buckets.set(g, list);
    }
  }

  // The prior for shrinking variance is the spread of the whole library.
  const allRatings = ctx.rated.map((r) => r.rating);
  const priorVar = allRatings.length >= 2 ? variance(allRatings) : 0;

  const genres = [...buckets.entries()]
    .filter(([, ratings]) => ratings.length >= GATES.subgroupMean)
    .map(([genre, ratings]) => {
      const raw = mean(ratings);
      const v = variance(ratings);
      return {
        genre,
        n: ratings.length,
        lift: shrink(raw, ratings.length, ctx.userMean, SHRINK_K) - ctx.userMean,
        // Variance gets the same shrinkage treatment as the mean: two good
        // Westerns should not produce a confident-looking spread either.
        spread: Math.sqrt(shrinkVariance(Number.isFinite(v) ? v : priorVar, ratings.length, priorVar, SHRINK_K)),
      };
    })
    .sort((a, b) => b.lift - a.lift);

  if (genres.length === 0) return { genres, mostCertain: null, mostVolatile: null };

  const spreads = [...genres].map((g) => g.spread).sort((a, b) => a - b);
  const medianSpread = spreads[Math.floor(spreads.length / 2)]!;

  const certainPool = genres.filter((g) => g.spread <= medianSpread);
  const mostCertain = (certainPool.length > 0 ? certainPool : genres)[0]!;
  const mostVolatile = [...genres].sort((a, b) => b.spread - a.spread)[0]!;

  return {
    genres,
    mostCertain: { genre: mostCertain.genre, lift: mostCertain.lift, spread: mostCertain.spread },
    mostVolatile: { genre: mostVolatile.genre, lift: mostVolatile.lift, spread: mostVolatile.spread },
  };
}
