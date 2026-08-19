import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/types.ts";
import { watchlistGraveyard, GRAVEYARD_DAYS } from "./watchlist-graveyard.ts";
import { ratingBarrier, BARRIER_MIN_GROUP, formatP } from "./rating-barrier.ts";

type Spec = {
  id: string; name?: string; rating?: number; year?: number; runtime?: number;
  lang?: string; votes?: number; voteAvg?: number; collectionId?: number | null; release?: string;
};

function ctxOf(films: Spec[], opts: { watchlist?: string } = {}): StatContext {
  const rated = films.filter((f) => f.rating != null);
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...rated.map((f) => `2024-01-01,"${f.name ?? f.id}",${f.year ?? 2015},https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings, watchlist: opts.watchlist });

  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: 1000 + i, title: f.name ?? f.id,
    releaseDate: f.release ?? `${f.year ?? 2015}-01-01`, runtime: f.runtime ?? 110,
    originalLanguage: f.lang ?? "en", voteAverage: f.voteAvg ?? 7, voteCount: f.votes ?? 4000,
    collectionId: f.collectionId ?? null, posterPath: null,
  }));

  return buildContext({
    summary,
    profile: { ...emptyProfile(), nRated: rated.length, nDistinctFilms: films.length },
    joined,
  });
}

const wlCsv = (...rows: string[]) => ["Date,Name,Year,Letterboxd URI", ...rows].join("\n");
const TODAY = "2026-08-18";

// ---- watchlist graveyard ------------------------------------------------

test("graveyard finds released films that have sat for over a year", () => {
  const films: Spec[] = [
    { id: "old1", name: "Old One", release: "2015-01-01" },
    { id: "old2", name: "Old Two", release: "2016-01-01" },
    { id: "new1", name: "Recent", release: "2026-01-01" },
  ];
  const r = watchlistGraveyard(ctxOf(films, {
    watchlist: wlCsv(
      `2022-01-01,Old One,2015,https://boxd.it/old1`,
      `2023-01-01,Old Two,2016,https://boxd.it/old2`,
      `2026-08-01,Recent,2026,https://boxd.it/new1`,
    ),
  }), TODAY);

  assert.equal(r.data.graveyard.length, 2, "two have waited over a year");
  assert.equal(r.data.graveyard[0]!.name, "Old One", "oldest first");
  assert.ok(r.data.graveyard[0]!.ageDays > GRAVEYARD_DAYS * 4);
  assert.equal(r.data.released.length, 3);
  assert.equal(r.finding, "strong");
});

test("unreleased films are never counted as neglect", () => {
  // A real watchlist was almost entirely films that do not exist yet.
  const films: Spec[] = [
    { id: "f1", name: "Spirit", release: "2027-06-01" },
    { id: "f2", name: "Dune: Part Three", release: "2026-12-18" },
    { id: "f3", name: "The Batman: Part II", release: "2028-10-01" },
  ];
  const r = watchlistGraveyard(ctxOf(films, {
    watchlist: wlCsv(
      `2025-01-23,Spirit,2027,https://boxd.it/f1`,
      `2025-03-12,Dune: Part Three,2026,https://boxd.it/f2`,
      `2025-03-24,The Batman: Part II,2028,https://boxd.it/f3`,
    ),
  }), TODAY);

  assert.equal(r.data.unreleased.length, 3);
  assert.equal(r.data.released.length, 0);
  assert.equal(r.data.graveyard.length, 0);
  assert.equal(r.finding, "none");
  if (r.finding === "none") assert.ok(/wishlist, not a backlog/.test(r.emptyCopy), r.emptyCopy);
  assert.equal(r.tone, "flattering", "waiting for unreleased films is not a character flaw");
});

test("a film with no known release date is treated as unreleased, not as neglect", () => {
  const films: Spec[] = [{ id: "f1", name: "Unknown", release: undefined }];
  const joinedless = ctxOf([], { watchlist: wlCsv(`2020-01-01,Ghost Film,2020,https://boxd.it/nope`) });
  const r = watchlistGraveyard(joinedless, TODAY);
  assert.equal(r.data.graveyard.length, 0, "must not accuse on missing data");
  assert.equal(r.data.unreleased.length, 1);
});

test("a healthy watchlist is reported as healthy", () => {
  const films: Spec[] = [{ id: "f1", name: "Recent", release: "2026-01-01" }];
  const r = watchlistGraveyard(ctxOf(films, {
    watchlist: wlCsv(`2026-07-01,Recent,2026,https://boxd.it/f1`),
  }), TODAY);
  assert.equal(r.data.graveyard.length, 0);
  assert.equal(r.finding, "weak");
  assert.equal(r.tone, "flattering");
});

test("an empty watchlist says so rather than dividing by zero", () => {
  const r = watchlistGraveyard(ctxOf([]), TODAY);
  assert.equal(r.data.total, 0);
  assert.equal(r.finding, "none");
  assert.equal(r.data.medianAgeDays, null);
});

// ---- rating barrier ----------------------------------------------------

test("the barrier compares the top two POPULATED bands, not a hardcoded 5 vs 4.5", () => {
  // No 5s at all -- the real export had exactly this shape.
  const films: Spec[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 170 })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 95 })),
  ];
  const r = ratingBarrier(ctxOf(films));
  assert.equal(r.data.upperRating, 4.5);
  assert.equal(r.data.lowerRating, 4);
});

test("a real feature difference is found and survives testing", () => {
  // Top band is consistently ~75 minutes longer.
  const films: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 160 + (i % 10) })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 85 + (i % 10) })),
  ];
  const r = ratingBarrier(ctxOf(films));
  assert.equal(r.data.best!.key, "runtime");
  assert.ok(r.data.survived, `expected survival, p=${r.data.p} threshold=${r.data.threshold}`);
  assert.equal(r.finding, "strong");
  assert.ok(/runtime/.test(r.headline), r.headline);
});

test("noise does NOT survive, and the stat says so", () => {
  // Identical distributions in both bands: nothing to find.
  const films: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 100 + (i % 20), year: 2000 + (i % 20) })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 100 + (i % 20), year: 2000 + (i % 20) })),
  ];
  const r = ratingBarrier(ctxOf(films));
  assert.equal(r.data.survived, false);
  assert.equal(r.finding, "weak");
  assert.ok(/mood, not anything about the films/.test(r.headline), r.headline);
});

test("the threshold is Bonferroni-corrected for the number of features tested", () => {
  const films: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 160 })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 90 })),
  ];
  const r = ratingBarrier(ctxOf(films));
  assert.ok(r.data.gaps.length >= 2, "several features are tested");
  assert.ok(
    Math.abs(r.data.threshold - 0.05 / r.data.gaps.length) < 1e-12,
    `threshold ${r.data.threshold} is not 0.05/${r.data.gaps.length}`,
  );
  assert.ok(r.data.threshold < 0.05, "selecting a maximum must cost you something");
});

test("bands below the minimum group size produce no comparison at all", () => {
  const films: Spec[] = [
    ...Array.from({ length: BARRIER_MIN_GROUP - 1 }, (_, i) => ({ id: `a${i}`, rating: 4.5 })),
    ...Array.from({ length: BARRIER_MIN_GROUP - 1 }, (_, i) => ({ id: `b${i}`, rating: 4 })),
  ];
  const r = ratingBarrier(ctxOf(films));
  assert.equal(r.data.upperRating, null);
  assert.equal(r.finding, "none");
});

test("both new stats survive an empty library", () => {
  const ctx = ctxOf([]);
  for (const stat of [watchlistGraveyard, ratingBarrier]) {
    const r = stat(ctx);
    const copy = r.finding === "none" ? r.emptyCopy : r.headline;
    assert.ok(copy.length > 20, `${stat.name} produced no sentence`);
    assert.ok(!/undefined|NaN|null|Infinity/.test(copy), `${stat.name}: ${copy}`);
  }
});

test("p-values never render as 0.000, which a permutation test cannot produce", () => {
  assert.equal(formatP(0.0004), "p<0.001");
  assert.equal(formatP(0), "p<0.001");
  assert.equal(formatP(0.032), "p=0.032");
  assert.equal(formatP(NaN), "p unavailable");

  const films: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 200 })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 80 })),
  ];
  const r = ratingBarrier(ctxOf(films));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(!/p=0\.000/.test(copy), copy);
});

test("the barrier does not claim other features were tested and failed", () => {
  const films: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, rating: 4.5, runtime: 200 })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, rating: 4, runtime: 80 })),
  ];
  const r = ratingBarrier(ctxOf(films));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  // Only the winning feature is permutation tested, so "the only thing" is a lie.
  assert.ok(!/only thing/i.test(copy), `overclaims exclusivity: ${copy}`);
});
