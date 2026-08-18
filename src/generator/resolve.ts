/**
 * Slug resolution pipeline: Letterboxd slug -> TMDB id -> stored metadata.
 *
 * Cache-first by design. A slug already in slug_map costs zero API calls, which
 * is what makes match quality compound across users instead of being re-paid
 * every upload.
 */
import { chooseMatch, type Candidate } from "../tmdb/match.ts";
import { NotFound, type TmdbClient } from "../tmdb/client.ts";
import type { Store } from "../store/db.ts";

export type ResolveInput = { slug: string; name: string; year: number | null };

export type ResolveStats = {
  total: number;
  cacheHits: number;
  cacheMisses: number;
  newlyResolved: number;
  newlyUnmatched: number;
  filmsFetched: number;
  filmsAlreadyStored: number;
  errors: { slug: string; message: string }[];
};

export function emptyStats(): ResolveStats {
  return {
    total: 0,
    cacheHits: 0,
    cacheMisses: 0,
    newlyResolved: 0,
    newlyUnmatched: 0,
    filmsFetched: 0,
    filmsAlreadyStored: 0,
    errors: [],
  };
}

/**
 * Resolve one slug and ensure its metadata is stored.
 *
 * Sequential per slug, but each step is cheap or cached; the caller parallelises
 * across slugs with `mapLimit`.
 */
export async function resolveOne(
  input: ResolveInput,
  client: TmdbClient,
  store: Store,
  stats: ResolveStats,
  { refetch = false } = {},
): Promise<number | null> {
  const cached = store.lookupSlug(input.slug);

  let tmdbId: number | null;
  if (cached) {
    stats.cacheHits++;
    tmdbId = cached.tmdbId;
    // A previously-recorded miss stays a miss until someone fixes it by hand.
    // Re-searching every build would burn the API budget on the same failures.
    if (tmdbId == null) return null;
  } else {
    stats.cacheMisses++;
    let candidates: Candidate[] = [];
    try {
      candidates = await client.searchMovie(input.name, input.year ?? undefined);
      // If a year-constrained search finds nothing, the Letterboxd year may
      // disagree with TMDB's release date. Retry unconstrained before giving up.
      if (candidates.length === 0 && input.year) {
        candidates = await client.searchMovie(input.name);
      }
    } catch (err) {
      stats.errors.push({ slug: input.slug, message: (err as Error).message });
      return null;
    }

    const outcome = chooseMatch(input.name, input.year, candidates, input.slug);
    store.recordSlug({
      slug: input.slug,
      tmdbId: outcome.tmdbId,
      confidence: outcome.confidence,
      method: outcome.method,
      sourceTitle: input.name,
      sourceYear: input.year,
    });

    if (outcome.tmdbId == null) {
      store.recordUnmatched(input.slug, input.name, input.year, outcome.confidence);
      stats.newlyUnmatched++;
      return null;
    }
    stats.newlyResolved++;
    tmdbId = outcome.tmdbId;
  }

  if (!refetch && store.hasFilm(tmdbId)) {
    stats.filmsAlreadyStored++;
    return tmdbId;
  }

  try {
    const film = await client.film(tmdbId);
    store.transaction(() => store.upsertFilm(film));
    stats.filmsFetched++;
    return tmdbId;
  } catch (err) {
    if (err instanceof NotFound) {
      // The id resolved but the film is gone from TMDB. Demote the mapping so we
      // don't keep trying, and flag it for manual review.
      store.recordSlug({
        slug: input.slug,
        tmdbId: null,
        confidence: 0,
        method: "tmdb_404",
        sourceTitle: input.name,
        sourceYear: input.year,
      });
      store.recordUnmatched(input.slug, input.name, input.year, 0);
    }
    stats.errors.push({ slug: input.slug, message: (err as Error).message });
    return null;
  }
}
