import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/db.ts";
import { tasteRadius } from "./taste-radius.ts";
import { genreConviction } from "./genre-conviction.ts";
import { halfStarTell } from "./half-star-tell.ts";
import { impossibleDays, IMPOSSIBLE_MINUTES } from "./impossible-days.ts";
import { popularityCorrelation } from "./popularity-correlation.ts";

type Spec = {
  id: string; name?: string; rating: number; year?: number; runtime?: number;
  lang?: string; votes?: number; tmdbId?: number;
};

function ctxOf(
  films: Spec[],
  opts: {
    diary?: string;
    genres?: Map<number, string[]>;
    countries?: Map<number, { code: string; weight: number }[]>;
  } = {},
): StatContext {
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...films.map((f) => `2024-01-01,"${f.name ?? f.id}",${f.year ?? 2015},https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings, diary: opts.diary });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: f.tmdbId ?? 1000 + i, title: f.name ?? f.id,
    releaseDate: `${f.year ?? 2015}-01-01`, runtime: f.runtime ?? 110,
    originalLanguage: f.lang ?? "en", voteAverage: 7, voteCount: f.votes ?? 4000,
    collectionId: null, posterPath: null,
  }));
  return buildContext({
    summary,
    profile: { ...emptyProfile(), nRated: films.length, nDistinctFilms: films.length },
    joined, genres: opts.genres, countries: opts.countries,
  });
}

// ---- taste radius --------------------------------------------------------

test("taste radius: a monolingual library reads as narrow", () => {
  const films = Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`, rating: 3.5, lang: i < 195 ? "en" : "fr", year: 2015,
  }));
  const r = tasteRadius(ctxOf(films));
  const langs = r.data.dimensions.find((d) => d.name === "languages")!;
  assert.equal(langs.touched, 2, "two languages touched");
  assert.ok(langs.radius < 1.5, `effective radius should be ~1, got ${langs.radius}`);
  assert.ok(/small radius/i.test(r.finding === "none" ? "" : r.title ?? ""), "title must reflect narrowness");
});

test("taste radius: an evenly spread library reads as wide", () => {
  const langs = ["en", "fr", "ja", "ko", "te", "es"];
  const films = Array.from({ length: 240 }, (_, i) => ({
    id: `f${i}`, rating: 3.5, lang: langs[i % 6]!, year: 1960 + (i % 60),
  }));
  const r = tasteRadius(ctxOf(films));
  const dim = r.data.dimensions.find((d) => d.name === "languages")!;
  assert.ok(dim.radius > 5, `six even languages should give ~6, got ${dim.radius}`);
  if (r.finding !== "none") assert.equal(r.tone, "flattering");
});

test("taste radius: country weights are fractional and cannot exceed the film count", () => {
  const countries = new Map([[1000, [{ code: "KR", weight: 0.5 }, { code: "US", weight: 0.5 }]]]);
  const r = tasteRadius(ctxOf([{ id: "a", rating: 4.5, tmdbId: 1000 }], { countries }));
  const total = r.data.countryWeights.reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights must total the film count, got ${total}`);
});

// ---- genre conviction ---------------------------------------------------

test("genre conviction: separates a confident genre from a volatile one", () => {
  // Animation: tight around 4. Horror: wildly split between 1 and 5.
  const genres = new Map<number, string[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 30; i++) {
    films.push({ id: `a${i}`, rating: i % 2 === 0 ? 4 : 4.5, tmdbId: 2000 + i });
    genres.set(2000 + i, ["Animation"]);
  }
  for (let i = 0; i < 30; i++) {
    films.push({ id: `h${i}`, rating: i % 2 === 0 ? 1 : 5, tmdbId: 3000 + i });
    genres.set(3000 + i, ["Horror"]);
  }
  const r = genreConviction(ctxOf(films, { genres }));
  assert.equal(r.data.mostVolatile!.genre, "Horror");
  assert.equal(r.data.mostCertain!.genre, "Animation");
  assert.ok(r.data.mostVolatile!.spread > r.data.mostCertain!.spread);
});

test("genre conviction: a genre below the subgroup minimum is excluded", () => {
  const genres = new Map<number, string[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 20; i++) {
    films.push({ id: `d${i}`, rating: 3.5, tmdbId: 4000 + i });
    genres.set(4000 + i, ["Drama"]);
  }
  // Only 3 Westerns, both rated 5. Must not become "your best genre".
  for (let i = 0; i < 3; i++) {
    films.push({ id: `w${i}`, rating: 5, tmdbId: 5000 + i });
    genres.set(5000 + i, ["Western"]);
  }
  const r = genreConviction(ctxOf(films, { genres }));
  assert.deepEqual(r.data.genres.map((g) => g.genre), ["Drama"]);
  assert.equal(r.finding, "weak", "one genre is not enough for the full comparison");
});

test("genre conviction: multi-label films land in every one of their genres", () => {
  const genres = new Map<number, string[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 20; i++) {
    films.push({ id: `f${i}`, rating: 4, tmdbId: 6000 + i });
    genres.set(6000 + i, ["Comedy", "Drama"]);
  }
  const r = genreConviction(ctxOf(films, { genres }));
  assert.equal(r.data.genres.length, 2, "one film counts in both buckets");
  for (const g of r.data.genres) assert.equal(g.n, 20);
});

// ---- half-star tell -----------------------------------------------------

test("half-star tell: a whole-numbers-only rater is identified", () => {
  const films = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, rating: [2, 3, 4][i % 3]! }));
  const r = halfStarTell(ctxOf(films));
  assert.equal(r.data.overallHalfShare, 0);
  if (r.finding !== "none") assert.ok(/don't use half stars/i.test(r.title ?? ""), r.title ?? "");
});

test("half-star tell: names the half steps never given", () => {
  // Half stars only above 3.
  const films = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, rating: [2, 3.5, 4.5, 3][i % 4]! }));
  const r = halfStarTell(ctxOf(films));
  assert.ok(r.data.missingHalves.includes(0.5));
  assert.ok(r.data.missingHalves.includes(1.5));
  assert.ok(!r.data.missingHalves.includes(3.5));
});

test("half-star tell: an even user shows no asymmetry, only real ones do", () => {
  const all = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const films = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, rating: all[i % 10]! }));
  const r = halfStarTell(ctxOf(films));

  assert.equal(r.data.missingHalves.length, 0);
  // Every band should sit at roughly its expected half-star rate.
  for (const b of r.data.bands) {
    assert.ok(Math.abs(b.halfLift - 1) < 0.2, `${b.label} lift ${b.halfLift} is an artifact`);
  }
  assert.equal(r.data.asymmetry, null, "band geometry must not manufacture an asymmetry");
  assert.equal(r.tone, "flattering");
});

test("half-star tell: a genuine asymmetry is still caught", () => {
  // Half steps used freely above 3, never below it.
  const films = Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`, rating: i % 2 === 0 ? [1, 2][i % 2 === 0 ? (i / 2) % 2 : 0]! : [3.5, 4.5][((i - 1) / 2) % 2]!,
  }));
  const r = halfStarTell(ctxOf(films));
  assert.ok(r.data.missingHalves.includes(0.5) && r.data.missingHalves.includes(1.5));
  assert.equal(r.finding, "strong");
});

// ---- impossible days ---------------------------------------------------

test("impossible days: flags a day on runtime, not film count", () => {
  // Six 90-minute shorts is 9 hours: long but real.
  const short = Array.from({ length: 6 }, (_, i) =>
    `2024-05-01,S${i},2015,https://boxd.it/czvs${i},4,,,2024-05-02`).join("\n");
  const films = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, rating: 4, runtime: 90 }));
  const r = impossibleDays(ctxOf(films, {
    diary: ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date", short].join("\n"),
  }));
  assert.equal(r.data.impossible.length, 0, "9 hours is not impossible");
  assert.ok(r.data.busiest!.minutes === 540);
});

test("impossible days: catches a genuinely impossible day", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    `2019-03-04,L${i},2015,https://boxd.it/czvl${i},4,,,2019-03-05`).join("\n");
  const films = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, rating: 4, runtime: 180 }));
  const r = impossibleDays(ctxOf(films, {
    diary: ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date", rows].join("\n"),
  }));
  assert.equal(r.data.impossible.length, 1);
  assert.ok(r.data.impossible[0]!.minutes >= IMPOSSIBLE_MINUTES);
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.equal(r.finding, "strong");
  assert.ok(/bulk import/i.test(copy), copy);
});

test("impossible days: films with unknown runtime are counted, not assumed zero", () => {
  const rows = `2024-05-01,X,2015,https://boxd.it/czvx1,4,,,2024-05-02`;
  const films: Spec[] = [{ id: "x1", name: "X", rating: 4 }];
  const joinedless = ctxOf(films, {
    diary: ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date", rows].join("\n"),
  });
  const r = impossibleDays(joinedless);
  assert.equal(r.data.daysLogged, 1);
  // The diary entry joins by (name, year); runtime comes from the film record.
  assert.ok(r.data.busiest!.films === 1);
});

// ---- popularity correlation -------------------------------------------

test("popularity correlation: detects liking what is widely seen", () => {
  // Higher ratings on higher vote counts, within one cohort.
  const films = Array.from({ length: 120 }, (_, i) => ({
    id: `f${i}`, rating: Math.min(5, 0.5 + Math.floor(i / 12) * 0.5),
    votes: 100 + i * 500, year: 2015,
  }));
  const r = popularityCorrelation(ctxOf(films));
  assert.ok(r.data.tau > 0.5, `expected strong positive tau, got ${r.data.tau}`);
  assert.equal(r.finding, "strong");
});

test("popularity correlation: no relationship is reported as such", () => {
  const films = Array.from({ length: 120 }, (_, i) => ({
    id: `f${i}`, rating: [1, 5, 2, 4, 3][i % 5]!, votes: 100 + i * 500, year: 2015,
  }));
  const r = popularityCorrelation(ctxOf(films));
  assert.ok(Math.abs(r.data.tau) < 0.15, `expected ~0, got ${r.data.tau}`);
  assert.equal(r.finding, "weak");
});

test("popularity correlation: films in an unmeasurable cohort are skipped, not guessed", () => {
  const films = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, rating: 3, votes: 1000 + i * 100, year: 2015 })),
    { id: "lonely", rating: 5, votes: 3, year: 1930, lang: "sv" },
  ];
  const r = popularityCorrelation(ctxOf(films));
  assert.equal(r.data.n, 20);
  assert.equal(r.data.skipped, 1);
});

test("all five new stats survive an empty library", () => {
  const ctx = ctxOf([]);
  for (const stat of [tasteRadius, genreConviction, halfStarTell, impossibleDays, popularityCorrelation]) {
    const r = stat(ctx);
    const copy = r.finding === "none" ? r.emptyCopy : r.headline;
    assert.ok(copy.length > 20, `${stat.name} produced no sentence on an empty library`);
    assert.ok(!/undefined|NaN|null/.test(copy), `${stat.name}: ${copy}`);
  }
});

test("half-star asymmetry is phrased as a ratio, never as a misleading multiplier", () => {
  // Half steps freely in the middle, never at the top.
  const ratings: number[] = [];
  for (let i = 0; i < 60; i++) ratings.push(i % 2 === 0 ? 2.5 : 3.5); // middling: all halves
  for (let i = 0; i < 60; i++) ratings.push(i % 2 === 0 ? 4 : 5); // loved: all wholes
  const films = ratings.map((rating, i) => ({ id: `f${i}`, rating }));

  const r = halfStarTell(ctxOf(films));
  const a = r.data.asymmetry;
  assert.ok(a, "a real asymmetry must be detected");
  // The generous band genuinely uses more, so any multiplier in the copy must be > 1.
  assert.ok(a!.ratio > 1 || !Number.isFinite(a!.ratio), `ratio must exceed 1, got ${a!.ratio}`);

  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  const multiplier = /([\d.]+) times as often/.exec(copy);
  if (multiplier) {
    assert.ok(Number(multiplier[1]) > 1, `copy claims "more often" at ${multiplier[1]}x: ${copy}`);
  }
});

test("a band with zero half stars does not produce an infinite multiplier in copy", () => {
  const ratings: number[] = [];
  for (let i = 0; i < 60; i++) ratings.push(2.5);
  for (let i = 0; i < 60; i++) ratings.push(5);
  const films = ratings.map((rating, i) => ({ id: `f${i}`, rating }));
  const r = halfStarTell(ctxOf(films));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(!/Infinity|NaN/.test(copy), copy);
});
