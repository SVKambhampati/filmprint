/**
 * Computing a user's SampleProfile — the numbers the selector judges stats
 * against.
 *
 * Split from the registry on purpose: the registry declares what stats NEED,
 * this measures what a user HAS, and neither knows about the other's internals.
 */
import type { ExportSummary } from "../hygiene/normalize.ts";
import type { JoinedFilm } from "../store/db.ts";
import { MIN_VOTE_COUNT } from "./calibration.ts";
import type { SampleProfile } from "./registry.ts";

/** Films per calendar year needed before that year can be sliced. */
const MIN_FILMS_PER_YEAR = 40;

/**
 * The rating band where a rewatch delta can move in both directions.
 * A 5-star first watch can only go down, so including it measures the ceiling
 * rather than disillusionment.
 */
const REWATCH_BAND: readonly [number, number] = [2.5, 4.0];

export type ProfileExtras = {
  /** Metadata for the user's films, from Store.joinedFilms. */
  joined?: Map<string, JoinedFilm>;
};

export function buildProfile(summary: ExportSummary, extras: ProfileExtras = {}): SampleProfile {
  const { diary, ratings, watched, watchlist } = summary;
  const joined = extras.joined ?? new Map<string, JoinedFilm>();

  // ---- crowd-comparable films -------------------------------------------
  // A rated film only counts if TMDB's average for it is stable enough to
  // compare against; otherwise obscure-film watchers read as contrarian purely
  // from the crowd's noise.
  let nRatedWithCrowd = 0;
  for (const r of ratings) {
    const f = joined.get(r.filmKey);
    if (f && f.voteCount >= MIN_VOTE_COUNT) nRatedWithCrowd++;
  }

  // ---- rewatches ---------------------------------------------------------
  const nRewatchEntries = diary.filter((e) => e.rewatch).length;

  // Films logged BOTH as a first watch and a rewatch, where the first-watch
  // rating leaves room to move in either direction.
  const byFilm = new Map<string, { first: number[]; again: number[] }>();
  for (const e of diary) {
    if (e.rating == null) continue;
    let g = byFilm.get(e.filmKey);
    if (!g) {
      g = { first: [], again: [] };
      byFilm.set(e.filmKey, g);
    }
    (e.rewatch ? g.again : g.first).push(e.rating);
  }
  let nPairedRewatch = 0;
  for (const g of byFilm.values()) {
    if (g.first.length === 0 || g.again.length === 0) continue;
    const firstRating = g.first[0]!;
    if (firstRating >= REWATCH_BAND[0] && firstRating <= REWATCH_BAND[1]) nPairedRewatch++;
  }

  // ---- years with enough data to slice -----------------------------------
  const perYear = new Map<number, number>();
  for (const e of diary) {
    if (!e.cleanDated || !e.watchedDate) continue;
    const y = Number.parseInt(e.watchedDate.slice(0, 4), 10);
    if (!Number.isFinite(y)) continue;
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const nYearsWithData = [...perYear.values()].filter((n) => n >= MIN_FILMS_PER_YEAR).length;

  // ---- collections entered ----------------------------------------------
  const collections = new Set<number>();
  for (const f of joined.values()) {
    if (f.collectionId != null) collections.add(f.collectionId);
  }

  const nTaggedEntries = diary.filter((e) => e.tags.length > 0).length;

  // Released watchlist films. An unreleased film cannot be "neglected".
  const today = new Date().toISOString().slice(0, 10);
  let nWatchlistReleased = 0;
  for (const w of watchlist) {
    const f = joined.get(w.filmKey);
    if (f?.releaseDate && f.releaseDate <= today) nWatchlistReleased++;
  }

  return {
    nRated: ratings.length,
    nWatched: watched.length,
    nDiary: diary.length,
    nCleanDated: diary.filter((e) => e.cleanDated).length,
    nWatchlist: watchlist.length,
    nWatchlistReleased,
    nRewatchEntries,
    nPairedRewatch,
    nReviews: summary.reviews.length,
    nTaggedEntries,
    nRatedWithCrowd,
    nDistinctFilms: summary.audit.distinctFilms,
    nYearsWithData,
    nCollectionsEntered: collections.size,
  };
}

/** A profile of all zeros, for tests and for the empty-export case. */
export function emptyProfile(): SampleProfile {
  return {
    nRated: 0, nWatched: 0, nDiary: 0, nCleanDated: 0, nWatchlist: 0, nWatchlistReleased: 0,
    nRewatchEntries: 0, nPairedRewatch: 0, nReviews: 0, nTaggedEntries: 0,
    nRatedWithCrowd: 0, nDistinctFilms: 0, nYearsWithData: 0, nCollectionsEntered: 0,
  };
}
