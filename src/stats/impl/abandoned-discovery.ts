/**
 * S1 — "Abandoned discoveries."
 *
 * Directors the user loved once and never returned to. Works BETTER at low n
 * than at high n, which makes it the best stat available for a light logger.
 *
 * LIMITATION, stated plainly: the punchiest version of this stat is "you've seen
 * 1 of their 6 films", and the filmography size needs a TMDB person-credits call
 * per candidate. This computes the part that comes from the user's own library —
 * loved once, never revisited — and reports `filmographySize: null`. Enriching
 * the top ~20 candidates is cheap and worth doing before this ships.
 */
import type { StatContext } from "../context.ts";

export const LOVED_RATING = 4.5;

export type Abandoned = {
  directorId: number;
  director: string;
  /** The film that earned the high rating. */
  film: string;
  rating: number;
  /** How many of this director's films the user has rated. 1 = abandoned. */
  seen: number;
  /** Total feature count. Null until enriched from TMDB person credits. */
  filmographySize: number | null;
  /** Other credited directors, when the film was co-directed. */
  coDirectors?: string[];
  posterPath: string | null;
};

export function abandonedDiscovery(ctx: StatContext, limit = 10): Abandoned[] {
  // Every director in the user's rated library, with the films they saw.
  const byDirector = new Map<number, { name: string; films: { name: string; rating: number; posterPath: string | null }[] }>();

  for (const r of ctx.rated) {
    for (const c of ctx.crew.get(r.film.tmdbId) ?? []) {
      if (c.job !== "Director") continue;
      const entry = byDirector.get(c.id) ?? { name: c.name, films: [] };
      entry.films.push({ name: r.name, rating: r.rating, posterPath: r.film.posterPath });
      byDirector.set(c.id, entry);
    }
  }

  const out: Abandoned[] = [];
  for (const [id, entry] of byDirector) {
    if (entry.films.length !== 1) continue; // seen more than once: not abandoned
    const only = entry.films[0]!;
    if (only.rating < LOVED_RATING) continue;
    out.push({
      directorId: id,
      director: entry.name,
      film: only.name,
      rating: only.rating,
      seen: 1,
      filmographySize: null,
      posterPath: only.posterPath,
    });
  }

  // Highest rating first; ties broken by name for determinism.
  out.sort((a, b) => b.rating - a.rating || a.director.localeCompare(b.director));

  // One entry per FILM. A co-directed film (animation especially: Across the
  // Spider-Verse has three credited directors) otherwise appears once per
  // director, which reads as three separate discoveries of the same thing.
  const seenFilms = new Set<string>();
  const deduped: Abandoned[] = [];
  for (const a of out) {
    if (seenFilms.has(a.film)) {
      const prev = deduped.find((d) => d.film === a.film)!;
      prev.coDirectors = [...(prev.coDirectors ?? []), a.director];
      continue;
    }
    seenFilms.add(a.film);
    deduped.push(a);
  }
  return deduped.slice(0, limit);
}
