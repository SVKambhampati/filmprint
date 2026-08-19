/**
 * The lookup handler: film identifiers in, metadata out.
 *
 * This is the ONLY server-side logic in the product, and it is deliberately
 * transport-agnostic — a pure function of (store, filmKeys). The Vite dev
 * middleware and any eventual serverless function are both thin wrappers, so
 * moving hosts never touches this file.
 *
 * What it must never do is accept anything other than film identifiers. Ratings,
 * dates and reviews stay in the browser; that is the whole privacy position, and
 * the request shape is where it is enforced.
 */
import type { Store } from "../store/db.ts";
import type { MetadataPayload } from "../store/types.ts";

/**
 * Cap on keys per request.
 *
 * A very large Letterboxd library is a few thousand films, so this is generous
 * for real use while refusing a request that is trying to dump the catalogue.
 */
export const MAX_KEYS = 12_000;

/** Film keys look like "boxd:jUk4" or "ty:<normalised title>:<year>". */
const KEY_PATTERN = /^(boxd:[A-Za-z0-9]{1,16}|ty:[^:]{0,200}:(\d{4}|\?))$/;

export type LookupRequest = { filmKeys: string[] };

export class BadRequest extends Error {}

/** Validate and normalise an untrusted request body. */
export function parseRequest(body: unknown): LookupRequest {
  if (typeof body !== "object" || body === null) throw new BadRequest("Expected a JSON object.");
  const keys = (body as { filmKeys?: unknown }).filmKeys;
  if (!Array.isArray(keys)) throw new BadRequest("Expected filmKeys to be an array of strings.");
  if (keys.length === 0) throw new BadRequest("filmKeys was empty.");
  if (keys.length > MAX_KEYS) throw new BadRequest(`Too many films: ${keys.length} exceeds ${MAX_KEYS}.`);

  const clean: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k !== "string" || !KEY_PATTERN.test(k)) continue; // skip junk rather than failing the whole upload
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(k);
  }
  if (clean.length === 0) throw new BadRequest("None of the supplied film identifiers were usable.");
  return { filmKeys: clean };
}

const obj = <V,>(m: Map<number | string, V>): Record<string, V> =>
  Object.fromEntries([...m.entries()].map(([k, v]) => [String(k), v]));

export function lookupPayload(store: Store, filmKeys: readonly string[]): MetadataPayload {
  const joined = store.joinedFilms(filmKeys);
  const films = [...joined.values()];
  const tmdbIds = films.map((f) => f.tmdbId);
  const collectionIds = [...new Set(films.map((f) => f.collectionId).filter((c): c is number => c != null))];

  return {
    films,
    genres: obj(store.genresFor(tmdbIds)),
    crew: obj(store.crewFor(tmdbIds)),
    cast: obj(store.castFor(tmdbIds)),
    keywords: obj(store.keywordsFor(tmdbIds)),
    countries: obj(store.countriesFor(tmdbIds)),
    collectionParts: obj(store.collectionPartsFor(collectionIds)),
    collectionNames: obj(store.collectionNames(collectionIds)),
    // Absent films are reported rather than silently omitted. On a real export
    // every one of these was a TV series, and the UI says so.
    unresolved: filmKeys.filter((k) => !joined.has(k)),
  };
}

/**
 * Weak ETag over the request, so a user who re-uploads the same export gets a 304
 * instead of another few hundred kilobytes. Film metadata barely changes, so the
 * key set plus a dataset stamp is enough to identify a response.
 */
export function etagFor(filmKeys: readonly string[], datasetStamp: string): string {
  const sorted = [...filmKeys].sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) * 0x01000193;
      h2 = (h2 + s.charCodeAt(i) * 31) | 0;
    }
  };
  feed(datasetStamp);
  for (const k of sorted) feed(k);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `W/"${hex(h1)}${hex(h2)}-${sorted.length}"`;
}
