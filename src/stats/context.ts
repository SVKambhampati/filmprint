/**
 * The shared input every stat receives.
 *
 * Built once per user so that 28 stats do not each re-derive the same joins, and
 * so each stat can stay a pure function of its input — which is what makes them
 * testable without a database.
 */
import type { ExportSummary } from "../hygiene/normalize.ts";
import type { JoinedFilm } from "../store/db.ts";
import { mean } from "./primitives.ts";
import type { SampleProfile } from "./registry.ts";
import { releaseYearOf } from "./util.ts";

export type RatedFilm = {
  filmKey: string;
  name: string;
  /** The CURRENT film-level rating, from ratings.csv. */
  rating: number;
  film: JoinedFilm;
};

export type StatContext = {
  summary: ExportSummary;
  profile: SampleProfile;
  /**
   * Rated films that resolved to TMDB. The denominator for every taste stat.
   * Films that never resolved are absent — mostly TV, and reported separately.
   */
  rated: readonly RatedFilm[];
  /** Mean of all the user's ratings. The shrinkage prior. */
  userMean: number;
  genres: Map<number, string[]>;
  crew: Map<number, { id: number; name: string; job: string }[]>;
  /** Fractional country weights per film — see Store.countriesFor. */
  countries: Map<number, { code: string; weight: number }[]>;
  cast: Map<number, { id: number; name: string; order: number }[]>;
  keywords: Map<number, string[]>;
  /** collectionId -> every film TMDB lists in that collection. */
  collectionParts: Map<number, { tmdbId: number; title: string; releaseDate: string | null }[]>;
  collectionNames: Map<number, string>;
  /** filmKey -> rated film, for stats that start from diary entries. */
  byKey: Map<string, RatedFilm>;
  /**
   * EVERY resolved film, rated or not.
   *
   * Needed because `rated` and `byKey` cover only ratings.csv. Watchlist films are
   * unwatched and therefore unrated, so a stat that looks them up in `byKey` finds
   * nothing and silently treats the whole list as unknown.
   */
  joined: Map<string, JoinedFilm>;
};

export function buildContext(input: {
  summary: ExportSummary;
  profile: SampleProfile;
  joined: Map<string, JoinedFilm>;
  genres?: Map<number, string[]>;
  crew?: Map<number, { id: number; name: string; job: string }[]>;
  countries?: Map<number, { code: string; weight: number }[]>;
  cast?: Map<number, { id: number; name: string; order: number }[]>;
  keywords?: Map<number, string[]>;
  collectionParts?: Map<number, { tmdbId: number; title: string; releaseDate: string | null }[]>;
  collectionNames?: Map<number, string>;
}): StatContext {
  const rated: RatedFilm[] = [];
  for (const r of input.summary.ratings) {
    const film = input.joined.get(r.filmKey);
    if (!film) continue;
    rated.push({ filmKey: r.filmKey, name: r.name, rating: r.rating, film });
  }

  return {
    summary: input.summary,
    profile: input.profile,
    rated,
    userMean: rated.length > 0 ? mean(rated.map((r) => r.rating)) : NaN,
    genres: input.genres ?? new Map(),
    crew: input.crew ?? new Map(),
    countries: input.countries ?? new Map(),
    cast: input.cast ?? new Map(),
    keywords: input.keywords ?? new Map(),
    collectionParts: input.collectionParts ?? new Map(),
    collectionNames: input.collectionNames ?? new Map(),
    byKey: new Map(rated.map((r) => [r.filmKey, r] as const)),
    joined: input.joined,
  };
}

export { releaseYearOf };
