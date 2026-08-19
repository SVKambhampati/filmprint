/**
 * The whole client-side pipeline: files in, a page's worth of data out.
 *
 * Everything here runs in the tab. The only thing that reaches a server is the
 * list of film identifiers, so metadata can be looked up — never a rating, never
 * a date, never a review. That is what makes the privacy claim true rather than
 * aspirational.
 */
import { unzipSync, strFromU8 } from "fflate";
import { normalizeExport, allFilms, type ExportSummary } from "../../../src/hygiene/normalize.ts";
import { buildProfile } from "../../../src/stats/profile.ts";
import { buildContext } from "../../../src/stats/context.ts";
import { composePage, type Page } from "../../../src/stats/compose.ts";
import type { MetadataPayload, JoinedFilm } from "../../../src/store/types.ts";
import type { SampleProfile } from "../../../src/stats/registry.ts";

export type ExportFiles = Partial<Record<"diary" | "ratings" | "watched" | "watchlist" | "reviews", string>>;

const WANTED = ["diary", "ratings", "watched", "watchlist", "reviews"] as const;
const isWanted = (stem: string): stem is keyof ExportFiles => (WANTED as readonly string[]).includes(stem);

/**
 * Pull the CSVs we care about out of a Letterboxd export zip.
 *
 * Only root-level files are read. The export segregates removed content into
 * `deleted/` and `orphaned/` subdirectories, and reading those would resurrect
 * films the user deleted on purpose.
 */
export function filesFromZip(bytes: Uint8Array): ExportFiles {
  const out: ExportFiles = {};
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (/(^|\/)(deleted|orphaned|lists|likes)\//i.test(name)) continue;
    const base = name.split("/").pop() ?? "";
    const stem = base.replace(/\.csv$/i, "").toLowerCase();
    if (isWanted(stem)) out[stem] = strFromU8(data);
  }
  return out;
}

/** Read loose CSVs, for someone who unzipped first. */
export async function filesFromList(files: File[]): Promise<ExportFiles> {
  const out: ExportFiles = {};
  for (const f of files) {
    const stem = f.name.replace(/\.csv$/i, "").toLowerCase();
    if (isWanted(stem)) out[stem] = await f.text();
  }
  return out;
}

export async function readDrop(files: File[]): Promise<ExportFiles> {
  const zip = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
  if (zip) return filesFromZip(new Uint8Array(await zip.arrayBuffer()));
  return filesFromList(files);
}

/** Turn the wire payload into the Maps the stats layer expects. */
function toMaps(payload: MetadataPayload) {
  const numKeyed = <V,>(rec: Record<string, V>): Map<number, V> =>
    new Map(Object.entries(rec).map(([k, v]) => [Number(k), v]));
  return {
    genres: numKeyed(payload.genres),
    crew: numKeyed(payload.crew),
    cast: numKeyed(payload.cast),
    keywords: numKeyed(payload.keywords),
    countries: numKeyed(payload.countries),
    collectionParts: numKeyed(payload.collectionParts),
    collectionNames: new Map(Object.entries(payload.collectionNames).map(([k, v]) => [Number(k), v])),
  };
}

export type Analysis = {
  summary: ExportSummary;
  profile: SampleProfile;
  page: Page;
  matched: number;
  requested: number;
};

export type LookupFn = (filmKeys: string[]) => Promise<MetadataPayload>;

/**
 * In development the payload is a static file. In production this becomes a POST
 * to the lookup endpoint carrying only film identifiers.
 */
export const fixtureLookup: LookupFn = async () => {
  const res = await fetch("/payload.json");
  if (!res.ok) throw new Error(`Could not load film metadata (${res.status}).`);
  return (await res.json()) as MetadataPayload;
};

export async function analyze(files: ExportFiles, lookup: LookupFn = fixtureLookup): Promise<Analysis> {
  const summary = normalizeExport(files);
  const filmKeys = [...allFilms(summary).keys()];
  if (filmKeys.length === 0) {
    throw new Error("No films found. A Letterboxd export should contain ratings.csv or watched.csv.");
  }

  const payload = await lookup(filmKeys);
  const maps = toMaps(payload);

  // Restrict to films this library actually references, in case the lookup
  // returned a superset.
  const wanted = new Set(filmKeys);
  const joined = new Map<string, JoinedFilm>(
    payload.films.filter((f) => wanted.has(f.filmKey)).map((f) => [f.filmKey, f]),
  );

  const profile = buildProfile(summary, { joined });
  const ctx = buildContext({ summary, profile, joined, ...maps });

  return { summary, profile, page: composePage(ctx, profile), matched: joined.size, requested: filmKeys.length };
}
