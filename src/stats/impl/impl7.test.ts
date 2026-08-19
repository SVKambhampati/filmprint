import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/types.ts";
import { completionistIndex, MIN_COLLECTIONS } from "./completionist-index.ts";

type Part = { tmdbId: number; title: string; releaseDate: string | null };
type Spec = { id: string; name?: string; rating?: number; tmdbId?: number; collectionId?: number | null };

function ctxOf(
  films: Spec[],
  collectionParts: Map<number, Part[]> = new Map(),
  collectionNames: Map<number, string> = new Map(),
): StatContext {
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...films.map((f) => `2024-01-01,"${f.name ?? f.id}",2015,https://boxd.it/${f.id},${f.rating ?? 4}`)].join("\n");
  const summary = normalizeExport({ ratings });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: f.tmdbId ?? 1000 + i, title: f.name ?? f.id,
    releaseDate: "2015-01-01", runtime: 110, originalLanguage: "en",
    voteAverage: 7, voteCount: 4000, collectionId: f.collectionId ?? null, posterPath: null,
  }));
  return buildContext({
    summary, profile: { ...emptyProfile(), nRated: films.length }, joined,
    collectionParts, collectionNames,
  });
}

const released = (id: number, title: string): Part => ({ tmdbId: id, title, releaseDate: "2020-01-01" });
const upcoming = (id: number, title: string): Part => ({ tmdbId: id, title, releaseDate: "2099-01-01" });

test("an UNRELEASED sequel never counts against completion", () => {
  // The user has seen both released Dune films. An announced third must not make
  // them look incomplete.
  const films: Spec[] = [
    { id: "d1", name: "Dune", tmdbId: 1, collectionId: 700 },
    { id: "d2", name: "Dune: Part Two", tmdbId: 2, collectionId: 700 },
  ];
  const parts = new Map([[700, [released(1, "Dune"), released(2, "Dune: Part Two"), upcoming(3, "Dune: Part Three")]]]);
  const d = completionistIndex(ctxOf(films, parts, new Map([[700, "Dune Collection"]]))).data;

  const dune = d.franchises.find((f) => f.collectionId === 700)!;
  assert.equal(dune.releasedParts, 2, "the denominator caps at released films");
  assert.equal(dune.unreleasedParts, 1);
  assert.equal(dune.completion, 1, "seeing both released films is 100%");
  assert.equal(dune.missing.length, 0);
});

test("an abandoned franchise lists what is actually missing", () => {
  const films: Spec[] = [{ id: "a1", name: "First", tmdbId: 10, collectionId: 800 }];
  const parts = new Map([[800, [released(10, "First"), released(11, "Second"), released(12, "Third")]]]);
  const d = completionistIndex(ctxOf(films, parts, new Map([[800, "A Trilogy"]]))).data;

  const f = d.franchises.find((x) => x.collectionId === 800)!;
  assert.equal(f.seen, 1);
  assert.equal(f.releasedParts, 3);
  assert.deepEqual(f.missing, ["Second", "Third"]);
});

test("a collection with only one released film is not abandonable", () => {
  const films: Spec[] = [{ id: "s1", name: "Solo", tmdbId: 20, collectionId: 900 }];
  const parts = new Map([[900, [released(20, "Solo"), upcoming(21, "Sequel")]]]);
  const d = completionistIndex(ctxOf(films, parts)).data;
  assert.equal(d.franchises.length, 0, "nothing to abandon with one released film");
});

test("a collection that was never fetched is skipped, not guessed at", () => {
  const films: Spec[] = [{ id: "u1", name: "Unknown", tmdbId: 30, collectionId: 999 }];
  const d = completionistIndex(ctxOf(films, new Map())).data;
  assert.equal(d.franchises.length, 0);
});

test("someone who finishes everything gets the flattering read", () => {
  const films: Spec[] = [];
  const parts = new Map<number, Part[]>();
  for (let c = 0; c < MIN_COLLECTIONS + 1; c++) {
    const cid = 1000 + c;
    parts.set(cid, [released(c * 10 + 1, `A${c}`), released(c * 10 + 2, `B${c}`)]);
    films.push({ id: `f${c}a`, name: `A${c}`, tmdbId: c * 10 + 1, collectionId: cid });
    films.push({ id: `f${c}b`, name: `B${c}`, tmdbId: c * 10 + 2, collectionId: cid });
  }
  const r = completionistIndex(ctxOf(films, parts));
  assert.equal(r.data.abandoned.length, 0);
  assert.equal(r.data.completionRate, 1);
  assert.equal(r.tone, "flattering");
});

test("a sampler is described as watching one and not returning, not 'abandoning at film 1'", () => {
  const films: Spec[] = [];
  const parts = new Map<number, Part[]>();
  for (let c = 0; c < MIN_COLLECTIONS + 3; c++) {
    const cid = 2000 + c;
    parts.set(cid, [released(c * 10 + 1, `A${c}`), released(c * 10 + 2, `B${c}`), released(c * 10 + 3, `C${c}`)]);
    films.push({ id: `f${c}`, name: `A${c}`, tmdbId: c * 10 + 1, collectionId: cid });
  }
  const r = completionistIndex(ctxOf(films, parts));
  assert.equal(r.data.medianStopPoint, 1);
  assert.equal(r.finding, "strong");
  assert.ok(/watch one film and never come back/.test(r.headline), r.headline);
  // "abandon them at film 1" reads as abandoning during the first film.
  assert.ok(!/at film 1/.test(r.headline), r.headline);
});

test("too few entered franchises yields no claim", () => {
  const films: Spec[] = [{ id: "a", name: "A", tmdbId: 1, collectionId: 500 }];
  const parts = new Map([[500, [released(1, "A"), released(2, "B")]]]);
  const r = completionistIndex(ctxOf(films, parts));
  assert.equal(r.finding, "none");
  assert.ok(/too few/.test(r.emptyCopy), r.emptyCopy);
});

test("completion never exceeds 100% even with a mis-tagged rewatch", () => {
  // Two library entries pointing at a two-film collection where one part is
  // duplicated: completion must clamp rather than read 150%.
  const films: Spec[] = [
    { id: "x1", name: "X1", tmdbId: 40, collectionId: 600 },
    { id: "x2", name: "X2", tmdbId: 41, collectionId: 600 },
    { id: "x3", name: "X3", tmdbId: 42, collectionId: 600 },
  ];
  const parts = new Map([[600, [released(40, "X1"), released(41, "X2")]]]);
  const d = completionistIndex(ctxOf(films, parts)).data;
  const f = d.franchises.find((x) => x.collectionId === 600)!;
  assert.ok(f.completion <= 1, `completion was ${f.completion}`);
  assert.ok(f.seen <= f.releasedParts);
});

test("completionist survives an empty library", () => {
  const r = completionistIndex(ctxOf([]));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(copy.length > 20);
  assert.ok(!/undefined|NaN|null/.test(copy), copy);
});
