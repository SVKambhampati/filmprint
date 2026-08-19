#!/usr/bin/env node
/**
 * Dump the metadata payload for an export:
 *   npm run dump:payload -- <path-to-unzipped-export> [outfile]
 *
 * This is exactly what the lookup endpoint will return, written to a file so the
 * browser app can be built and iterated on without a server running.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import path from "node:path";
import { Store } from "../store/db.ts";
import { normalizeExport, allFilms } from "../hygiene/normalize.ts";
import type { MetadataPayload } from "../store/types.ts";

const dir = process.argv[2];
const outfile = process.argv[3] ?? "web/public/payload.json";
if (!dir || !existsSync(dir)) {
  console.error("usage: npm run dump:payload -- <path-to-unzipped-export> [outfile]");
  process.exit(1);
}
const read = async (f: string) => (existsSync(path.join(dir, f)) ? readFile(path.join(dir, f), "utf8") : "");

const summary = normalizeExport({
  diary: await read("diary.csv"),
  ratings: await read("ratings.csv"),
  watched: await read("watched.csv"),
  watchlist: await read("watchlist.csv"),
  reviews: await read("reviews.csv"),
});

const store = new Store(process.env.FILMPRINT_DB ?? "data/filmprint.db");
const keys = [...allFilms(summary).keys()];
const joined = store.joinedFilms(keys);
const tmdbIds = [...joined.values()].map((f) => f.tmdbId);
const collectionIds = [...new Set([...joined.values()].map((f) => f.collectionId).filter((c): c is number => c != null))];

const obj = <V,>(m: Map<number | string, V>): Record<string, V> =>
  Object.fromEntries([...m.entries()].map(([k, v]) => [String(k), v]));

const payload: MetadataPayload = {
  films: [...joined.values()],
  genres: obj(store.genresFor(tmdbIds)),
  crew: obj(store.crewFor(tmdbIds)),
  cast: obj(store.castFor(tmdbIds)),
  keywords: obj(store.keywordsFor(tmdbIds)),
  countries: obj(store.countriesFor(tmdbIds)),
  collectionParts: obj(store.collectionPartsFor(collectionIds)),
  collectionNames: obj(store.collectionNames(collectionIds)),
  unresolved: keys.filter((k) => !joined.has(k)),
};

const json = JSON.stringify(payload);
await writeFile(outfile, json);
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(`wrote ${outfile}`);
console.log(`  films        ${payload.films.length}`);
console.log(`  unresolved   ${payload.unresolved.length}  (overwhelmingly TV)`);
console.log(`  raw          ${kb(Buffer.byteLength(json))}`);
console.log(`  gzip         ${kb(gzipSync(json).length)}`);
console.log(`  brotli       ${kb(brotliCompressSync(json).length)}`);
store.close();
