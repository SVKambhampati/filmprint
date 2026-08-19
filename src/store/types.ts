/**
 * Data shapes shared between the store and the stats layer.
 *
 * Deliberately separate from db.ts, which imports node:sqlite. The stats and
 * hygiene layers must stay browser-safe — they run in the user's tab, not on a
 * server — and importing a type from a module that pulls in a Node builtin works
 * only as long as every such import stays `import type`. One accidental value
 * import would drag node:sqlite into the browser bundle.
 *
 * Keeping the types here removes that hazard structurally rather than relying on
 * discipline. See the architecture test in browser-safety.test.ts.
 */

export type JoinedFilm = {
  filmKey: string;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  runtime: number | null;
  originalLanguage: string;
  voteAverage: number;
  voteCount: number;
  collectionId: number | null;
  posterPath: string | null;
};

export type CollectionPart = { tmdbId: number; title: string; releaseDate: string | null };
export type CrewCredit = { id: number; name: string; job: string };
export type CastCredit = { id: number; name: string; order: number };
export type CountryWeight = { code: string; weight: number };

/**
 * Everything the browser needs to compute stats for one library.
 *
 * Measured at 344 KB brotli for an 1,862-film library, which is why every stat
 * can run client-side: the payload is smaller than a single hero image, so there
 * is no reason to move computation to a server and no reason for ratings to ever
 * leave the machine.
 */
export type MetadataPayload = {
  films: JoinedFilm[];
  genres: Record<string, string[]>;
  crew: Record<string, CrewCredit[]>;
  cast: Record<string, CastCredit[]>;
  keywords: Record<string, string[]>;
  countries: Record<string, CountryWeight[]>;
  collectionParts: Record<string, CollectionPart[]>;
  collectionNames: Record<string, string>;
  /** Film keys the server could not resolve — overwhelmingly TV. */
  unresolved: string[];
};
