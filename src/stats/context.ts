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
};

export function buildContext(input: {
  summary: ExportSummary;
  profile: SampleProfile;
  joined: Map<string, JoinedFilm>;
  genres?: Map<number, string[]>;
  crew?: Map<number, { id: number; name: string; job: string }[]>;
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
  };
}

export { releaseYearOf };
