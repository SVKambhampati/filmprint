/**
 * S20 — "The actor you keep watching but never love."
 *
 * The most frequently appearing top-billed actor in the library whose films never
 * make the user's highest-rated set. It is a blindspot rather than a dislike: you
 * keep showing up for this person and it keeps not landing.
 *
 * TMDB billing order is unreliable for older and non-English films, so this is
 * capped at order <= 8 and will be weakest exactly where a user's taste is most
 * interesting. That is a real limitation, not a tuning problem.
 */
import type { StatContext } from "../context.ts";
import { shrink, quantile } from "../primitives.ts";
import { SHRINK_K, GATES } from "../../hygiene/thresholds.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Films needed with an actor before judging them. */
export const ACTOR_MIN_FILMS = 5;
/** "Top rated" means at or above this quantile of the user's own ratings. */
export const TOP_QUANTILE = 0.9;

export type Actor = {
  id: number;
  name: string;
  films: number;
  /** Shrunk mean rating of their films, minus the user's overall mean. */
  lift: number;
  /** How many of their films are in the user's top decile. */
  inTop: number;
  bestFilm: { name: string; rating: number } | null;
};

export type CastBlindspot = {
  /** Actors with enough films, sorted by count. */
  actors: Actor[];
  /** Most-seen actor with zero films in the top decile. */
  blindspot: Actor | null;
  /** Most-seen actor whose lift is highest — the flattering counterpart. */
  favourite: Actor | null;
  /** The rating value that defines the top decile. */
  topThreshold: number;
};

export function castBlindspot(ctx: StatContext): StatResult<CastBlindspot> {
  const d = computeCastBlindspot(ctx);

  if (d.actors.length === 0) {
    return none(
      d,
      `No actor appears in ${ACTOR_MIN_FILMS} or more of your films with top billing, so there is no ` +
        `pattern to find yet.`,
    );
  }

  if (d.blindspot) {
    return strong(
      d,
      // "seen X 34 times" reads as a film rewatched 34 times. It is 34 different films.
      `${d.blindspot.name} appears in ${d.blindspot.films} films you have rated, and not one of them ` +
        `is in your top rated. You keep showing up and it keeps not landing — their average sits ` +
        `${Math.abs(d.blindspot.lift).toFixed(2)} stars ${d.blindspot.lift < 0 ? "below" : "above"} ` +
        `your own.`,
    );
  }

  if (d.favourite) {
    return weak(
      d,
      `Every actor appearing in ${ACTOR_MIN_FILMS}+ of your films has at least one in your top rated. ` +
        `${d.favourite.name} leads on ${d.favourite.films} films at ` +
        `${d.favourite.lift >= 0 ? "+" : ""}${d.favourite.lift.toFixed(2)} stars against your average.`,
      { title: "You have no cast blindspot", tone: "flattering" },
    );
  }

  return weak(d, `Not enough of your top-billed actors recur often enough to read a pattern from.`);
}

function computeCastBlindspot(ctx: StatContext): CastBlindspot {
  const ratings = ctx.rated.map((r) => r.rating);
  const topThreshold = ratings.length > 0 ? quantile(ratings, TOP_QUANTILE) : NaN;

  const byActor = new Map<number, { name: string; films: { name: string; rating: number }[] }>();
  for (const r of ctx.rated) {
    for (const c of ctx.cast.get(r.film.tmdbId) ?? []) {
      const e = byActor.get(c.id) ?? { name: c.name, films: [] };
      e.films.push({ name: r.name, rating: r.rating });
      byActor.set(c.id, e);
    }
  }

  const actors: Actor[] = [...byActor.entries()]
    .filter(([, e]) => e.films.length >= ACTOR_MIN_FILMS)
    .map(([id, e]) => {
      const mean = e.films.reduce((a, f) => a + f.rating, 0) / e.films.length;
      const best = [...e.films].sort((a, b) => b.rating - a.rating)[0] ?? null;
      return {
        id,
        name: e.name,
        films: e.films.length,
        lift: shrink(mean, e.films.length, ctx.userMean, SHRINK_K) - ctx.userMean,
        inTop: e.films.filter((f) => f.rating >= topThreshold).length,
        bestFilm: best,
      };
    })
    .sort((a, b) => b.films - a.films);

  // A blindspot needs a real sample AND a genuinely negative lift, or a
  // frequently-seen actor whose films happen to cluster just below the threshold
  // would be labelled a disappointment on nothing.
  const blindspot =
    actors.find((a) => a.inTop === 0 && a.films >= GATES.subgroupName && a.lift < 0) ?? null;
  const favourite = [...actors].sort((a, b) => b.lift - a.lift)[0] ?? null;

  return { actors, blindspot, favourite, topThreshold };
}
