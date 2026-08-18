/**
 * The film metadata we store, and nothing else.
 *
 * The field list is fixed by what the stats actually need. Four fields are
 * deliberately absent because the stats that would use them were cut:
 *
 *   budget, revenue  - zero for a large share of films, and 0 is
 *                      indistinguishable from missing. Never inflation-adjusted.
 *   popularity       - a live value that changes weekly, so any stat built on it
 *                      is not reproducible next month. vote_count is the stable
 *                      substitute.
 *   person gender    - unspecified for a large share of crew, so any diversity
 *                      score would be a moral scorecard with ~30% missing data.
 *
 * Don't add them back without a stat that needs them.
 */

/** Crew jobs we keep. Everything else is dropped at extraction time. */
export const KEPT_CREW_JOBS = new Set([
  "Director",
  "Director of Photography",
  "Original Music Composer",
  "Editor",
]);

/**
 * Cast billing cutoff. TMDB's billing order is unreliable for older and
 * non-English films, so we keep only the top of the bill and accept that this
 * stat is weakest exactly where a user's taste is most interesting.
 */
export const MAX_BILLING_ORDER = 8;

export type Person = { id: number; name: string; job: string };
export type CastMember = { id: number; name: string; order: number };
/** Country with fractional weight — see `countries` below. */
export type CountryShare = { code: string; weight: number };

export type FilmMetadata = {
  tmdbId: number;
  title: string;
  originalTitle: string;
  /** ISO yyyy-mm-dd, or null. May be a festival or re-release date, not a local one. */
  releaseDate: string | null;
  /** Minutes. Null or 0 for many shorts and unreleased entries. */
  runtime: number | null;
  /** ISO 639-1. This is a LANGUAGE, not a nationality: Parasite is "ko". */
  originalLanguage: string;
  spokenLanguages: string[];
  genres: string[];
  /**
   * Fractional attribution, baked in at extraction: a four-country co-production
   * contributes 0.25 to each. Counting each country as a full 1 makes derived
   * shares exceed 100% and silently breaks every percentage downstream, so the
   * weight is not optional and not computed later.
   */
  countries: CountryShare[];
  companies: { id: number; name: string }[];
  collectionId: number | null;
  collectionName: string | null;
  voteAverage: number;
  voteCount: number;
  keywords: string[];
  crew: Person[];
  cast: CastMember[];
  posterPath: string | null;
  /**
   * When vote_average / vote_count were read. Required for reproducibility:
   * without it, a stat computed today cannot be explained next month.
   */
  fetchedAt: string;
};

/** Single request that gets everything: /movie/{id}?append_to_response=credits,keywords */
export const APPEND_TO_RESPONSE = "credits,keywords";

type RawMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  runtime?: number | null;
  original_language?: string;
  spoken_languages?: { iso_639_1: string }[];
  genres?: { name: string }[];
  production_countries?: { iso_3166_1: string }[];
  production_companies?: { id: number; name: string }[];
  belongs_to_collection?: { id: number; name: string } | null;
  vote_average?: number;
  vote_count?: number;
  poster_path?: string | null;
  credits?: {
    cast?: { id: number; name: string; order?: number }[];
    crew?: { id: number; name: string; job?: string }[];
  };
  keywords?: { keywords?: { name: string }[] };
};

export function extractFilm(raw: RawMovie, fetchedAt = new Date().toISOString()): FilmMetadata {
  const rawCountries = raw.production_countries ?? [];
  const weight = rawCountries.length > 0 ? 1 / rawCountries.length : 0;

  const crew: Person[] = [];
  const seenCrew = new Set<string>();
  for (const c of raw.credits?.crew ?? []) {
    if (!c.job || !KEPT_CREW_JOBS.has(c.job)) continue;
    // A person can be credited twice for the same job on one film.
    const key = `${c.id}:${c.job}`;
    if (seenCrew.has(key)) continue;
    seenCrew.add(key);
    crew.push({ id: c.id, name: c.name, job: c.job });
  }

  const cast: CastMember[] = [];
  for (const c of raw.credits?.cast ?? []) {
    const order = c.order ?? Number.MAX_SAFE_INTEGER;
    if (order > MAX_BILLING_ORDER) continue;
    cast.push({ id: c.id, name: c.name, order });
  }
  cast.sort((a, b) => a.order - b.order);

  return {
    tmdbId: raw.id,
    title: raw.title ?? raw.original_title ?? "",
    originalTitle: raw.original_title ?? raw.title ?? "",
    releaseDate: raw.release_date && raw.release_date.length > 0 ? raw.release_date : null,
    runtime: raw.runtime && raw.runtime > 0 ? raw.runtime : null,
    originalLanguage: raw.original_language ?? "",
    spokenLanguages: (raw.spoken_languages ?? []).map((l) => l.iso_639_1),
    genres: (raw.genres ?? []).map((g) => g.name),
    countries: rawCountries.map((c) => ({ code: c.iso_3166_1, weight })),
    companies: (raw.production_companies ?? []).map((c) => ({ id: c.id, name: c.name })),
    collectionId: raw.belongs_to_collection?.id ?? null,
    collectionName: raw.belongs_to_collection?.name ?? null,
    voteAverage: raw.vote_average ?? 0,
    voteCount: raw.vote_count ?? 0,
    keywords: (raw.keywords?.keywords ?? []).map((k) => k.name),
    crew,
    cast,
    posterPath: raw.poster_path ?? null,
    fetchedAt,
  };
}

/** Release year, from release_date. Null when TMDB has no date. */
export function releaseYear(f: Pick<FilmMetadata, "releaseDate">): number | null {
  if (!f.releaseDate) return null;
  const y = Number.parseInt(f.releaseDate.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

export function director(f: Pick<FilmMetadata, "crew">): Person | undefined {
  return f.crew.find((c) => c.job === "Director");
}
