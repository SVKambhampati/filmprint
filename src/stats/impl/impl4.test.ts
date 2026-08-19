import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId, reviewToPlainText, countWords } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/db.ts";
import { reviewAsymmetry } from "./review-asymmetry.ts";
import { runtimePrestige } from "./runtime-prestige.ts";
import { castBlindspot, ACTOR_MIN_FILMS } from "./cast-blindspot.ts";
import { languageEntryPoints } from "./language-entry-points.ts";
import { languageName, harshnessSplit } from "./harshness-split.ts";
import { IMPLEMENTATIONS } from "../compose.ts";
import { STATS } from "../registry.ts";

type Spec = { id: string; name?: string; rating?: number; year?: number; runtime?: number; lang?: string; votes?: number; voteAvg?: number; tmdbId?: number };

function ctxOf(
  films: Spec[],
  opts: { diary?: string; reviews?: string; cast?: Map<number, { id: number; name: string; order: number }[]> } = {},
): StatContext {
  const rated = films.filter((f) => f.rating != null);
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...rated.map((f) => `2024-01-01,"${f.name ?? f.id}",${f.year ?? 2015},https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings, diary: opts.diary, reviews: opts.reviews });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: f.tmdbId ?? 1000 + i, title: f.name ?? f.id,
    releaseDate: `${f.year ?? 2015}-01-01`, runtime: f.runtime ?? 110,
    originalLanguage: f.lang ?? "en", voteAverage: f.voteAvg ?? 7, voteCount: f.votes ?? 4000,
    collectionId: null, posterPath: null,
  }));
  return buildContext({
    summary, profile: { ...emptyProfile(), nRated: rated.length }, joined, cast: opts.cast,
  });
}

const REVIEW_HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date";
const DIARY_HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";

// ---- review plumbing ---------------------------------------------------

test("review HTML is stripped before words are counted", () => {
  assert.equal(reviewToPlainText("<p>Great <em>film</em>!</p>"), "Great film !");
  assert.equal(reviewToPlainText("a<br>b"), "a b");
  assert.equal(reviewToPlainText("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(reviewToPlainText("  spaced   out  "), "spaced out");
  // Markup must not inflate the count.
  assert.equal(countWords(reviewToPlainText("<div><span>one two</span></div>")), 2);
  assert.equal(countWords(""), 0);
});

test("reviews join to diary entries by entry id, not by title", () => {
  const summary = normalizeExport({
    diary: [DIARY_HEADER, `2024-03-12,Aftersun,2022,https://boxd.it/czvAAA,4.5,,,2024-03-10`].join("\n"),
    watched: ["Date,Name,Year,Letterboxd URI", `2024-01-01,Aftersun,2022,https://boxd.it/aft1`].join("\n"),
    reviews: [REVIEW_HEADER, `2024-03-12,Aftersun,2022,https://boxd.it/czvAAA,4.5,,"Quietly devastating.",,2024-03-10`].join("\n"),
  });
  assert.equal(summary.reviews.length, 1);
  assert.equal(summary.reviews[0]!.entryId, "czvAAA");
  // Inherits the diary entry's film key, which resolved to the real film id.
  assert.equal(summary.reviews[0]!.filmKey, filmKeyFromId("aft1"));
  assert.equal(summary.reviews[0]!.wordCount, 2);
});

test("an empty review body is not counted as a review", () => {
  const summary = normalizeExport({
    reviews: [REVIEW_HEADER, `2024-03-12,X,2022,https://boxd.it/czvAAA,4,,"",,2024-03-10`].join("\n"),
  });
  assert.equal(summary.reviews.length, 0);
  assert.equal(summary.audit.reviewRows, 0);
});

// ---- review asymmetry -------------------------------------------------

test("review asymmetry separates rate from length", () => {
  // 30 loved films, 30 disliked. Long reviews only on the disliked ones.
  const films: Spec[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, rating: 4.5 })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, rating: 1.5 })),
  ];
  const rows: string[] = [];
  for (let i = 0; i < 10; i++) rows.push(`2024-01-01,L${i},2015,https://boxd.it/czvL${i},4.5,,"good",,2024-01-01`);
  for (let i = 0; i < 10; i++) {
    rows.push(`2024-01-01,D${i},2015,https://boxd.it/czvD${i},1.5,,"${"word ".repeat(60).trim()}",,2024-01-01`);
  }
  const r = reviewAsymmetry(ctxOf(films, { reviews: [REVIEW_HEADER, ...rows].join("\n") }));

  assert.equal(r.data.totalReviews, 20);
  assert.ok(r.data.lengthGap, "a 60x length difference must be detected");
  assert.equal(r.data.lengthGap!.longer.label, "disliked");
  assert.equal(r.finding, "strong");
  assert.ok(/words on films you disliked/.test(r.headline), r.headline);
});

test("review rate uses rated films as the denominator", () => {
  const films: Spec[] = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, rating: 4 }));
  const rows = Array.from({ length: 10 }, (_, i) =>
    `2024-01-01,F${i},2015,https://boxd.it/czvF${i},4,,"a review here",,2024-01-01`);
  const r = reviewAsymmetry(ctxOf(films, { reviews: [REVIEW_HEADER, ...rows].join("\n") }));
  assert.ok(Math.abs(r.data.overallRate - 0.25) < 1e-9, `expected 0.25, got ${r.data.overallRate}`);
});

test("no reviews is stated, not divided by zero", () => {
  const r = reviewAsymmetry(ctxOf([{ id: "a", rating: 4 }]));
  assert.equal(r.finding, "none");
  assert.equal(r.data.overallRate, 0);
});

// ---- runtime prestige -------------------------------------------------

test("runtime prestige differences the user against the crowd on the same films", () => {
  // User rewards длину; crowd is indifferent to it.
  const films: Spec[] = Array.from({ length: 150 }, (_, i) => ({
    id: `f${i}`, rating: Math.min(5, 0.5 + Math.floor(i / 30) * 1),
    runtime: 80 + i, voteAvg: 5 + (i % 5), votes: 5000,
  }));
  const r = runtimePrestige(ctxOf(films));
  assert.ok(r.data.userTau > 0.5, `user tau should be high, got ${r.data.userTau}`);
  assert.ok(Math.abs(r.data.crowdTau) < 0.3, `crowd tau should be near zero, got ${r.data.crowdTau}`);
  assert.ok(r.data.delta > 0.2, `delta should be clearly positive, got ${r.data.delta}`);
  assert.equal(r.finding, "strong");
});

test("runtime prestige withholds a claim when the interval crosses zero", () => {
  // User and crowd must track runtime with the SAME tie structure, or the taus
  // differ for a structural reason rather than a substantive one: a continuous
  // crowd score against a 10-value user scale gives crowdTau ~1 and userTau <1
  // even when both are perfectly monotone in runtime.
  const films: Spec[] = Array.from({ length: 150 }, (_, i) => ({
    id: `f${i}`, rating: Math.min(5, 0.5 + Math.floor(i / 30) * 1),
    runtime: 80 + i, voteAvg: 5 + Math.floor(i / 30) * 0.5, votes: 5000,
  }));
  const r = runtimePrestige(ctxOf(films));
  assert.ok(Math.abs(r.data.delta) < 0.15, `delta should be small, got ${r.data.delta}`);
  assert.equal(r.finding, "weak");
  assert.ok(/not doing secret work/.test(r.headline), r.headline);
});

test("runtime prestige needs both a runtime and a comparable crowd score", () => {
  const films: Spec[] = Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, rating: 4, votes: 5 }));
  const r = runtimePrestige(ctxOf(films));
  assert.equal(r.finding, "none");
});

// ---- cast blindspot --------------------------------------------------

test("cast blindspot finds the recurring actor who never lands", () => {
  const cast = new Map<number, { id: number; name: string; order: number }[]>();
  const films: Spec[] = [];
  // Six films with an actor, all mediocre.
  for (let i = 0; i < 6; i++) {
    films.push({ id: `m${i}`, name: `Mid ${i}`, rating: 2.5, tmdbId: 7000 + i });
    cast.set(7000 + i, [{ id: 1, name: "Recurring Actor", order: 0 }]);
  }
  // Plus a spread of highly-rated films with someone else.
  for (let i = 0; i < 20; i++) {
    films.push({ id: `g${i}`, name: `Great ${i}`, rating: 5, tmdbId: 8000 + i });
    cast.set(8000 + i, [{ id: 2, name: "Other Actor", order: 0 }]);
  }
  const r = castBlindspot(ctxOf(films, { cast }));
  assert.equal(r.data.blindspot!.name, "Recurring Actor");
  assert.equal(r.data.blindspot!.inTop, 0);
  assert.ok(r.data.blindspot!.lift < 0);
  assert.equal(r.finding, "strong");
});

test("an actor below the minimum film count is never named a blindspot", () => {
  const cast = new Map<number, { id: number; name: string; order: number }[]>();
  const films: Spec[] = [];
  for (let i = 0; i < ACTOR_MIN_FILMS - 1; i++) {
    films.push({ id: `x${i}`, rating: 1, tmdbId: 9000 + i });
    cast.set(9000 + i, [{ id: 1, name: "Barely Seen", order: 0 }]);
  }
  for (let i = 0; i < 20; i++) {
    films.push({ id: `y${i}`, rating: 4.5, tmdbId: 9100 + i });
    cast.set(9100 + i, [{ id: 2, name: "Frequent", order: 0 }]);
  }
  const r = castBlindspot(ctxOf(films, { cast }));
  assert.ok(!r.data.actors.some((a) => a.name === "Barely Seen"));
  assert.notEqual(r.data.blindspot?.name, "Barely Seen");
});

test("no cast data at all is reported honestly", () => {
  const films: Spec[] = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, rating: 4 }));
  const r = castBlindspot(ctxOf(films));
  assert.equal(r.finding, "none");
  assert.equal(r.data.actors.length, 0);
});

// ---- language entry points ------------------------------------------

test("language entry points find the film that opened a cinema", () => {
  const rows = [
    `2024-01-05,Drive My Car,2021,https://boxd.it/czvJ1,4.5,,,2024-01-04`,
    `2024-03-05,Shoplifters,2018,https://boxd.it/czvJ2,4,,,2024-03-04`,
    `2024-05-05,Perfect Days,2023,https://boxd.it/czvJ3,4.5,,,2024-05-04`,
    // Korean, tried once and never again.
    `2024-02-05,Oldboy,2003,https://boxd.it/czvK1,3.5,,,2024-02-04`,
  ];
  const films: Spec[] = [
    { id: "j1", name: "Drive My Car", year: 2021, rating: 4.5, lang: "ja" },
    { id: "j2", name: "Shoplifters", year: 2018, rating: 4, lang: "ja" },
    { id: "j3", name: "Perfect Days", year: 2023, rating: 4.5, lang: "ja" },
    { id: "k1", name: "Oldboy", year: 2003, rating: 3.5, lang: "ko" },
  ];
  const r = languageEntryPoints(ctxOf(films, { diary: [DIARY_HEADER, ...rows].join("\n") }));

  assert.equal(r.data.bestOpener!.film, "Drive My Car");
  assert.equal(r.data.bestOpener!.languageLabel, "Japanese");
  assert.equal(r.data.bestOpener!.followedBy, 2);
  assert.ok(r.data.bestOpener!.startedStreak);
  assert.deepEqual(r.data.deadEnds.map((e) => e.languageLabel), ["Korean"]);
  assert.equal(r.finding, "strong");
});

test("English is never treated as a discovery", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    `2024-0${i + 1}-05,EN ${i},2015,https://boxd.it/czvE${i},4,,,2024-0${i + 1}-04`);
  const films: Spec[] = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, name: `EN ${i}`, rating: 4, lang: "en" }));
  const r = languageEntryPoints(ctxOf(films, { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.equal(r.data.entryPoints.length, 0);
  assert.equal(r.finding, "none");
});

test("backfilled entries are excluded from entry points", () => {
  // Logged years after watching: cleanDated is false, so this cannot be an entry point.
  const rows = [`2026-01-11,Old Japanese Film,2005,https://boxd.it/czvB1,4,,,2019-01-04`];
  const films: Spec[] = [{ id: "b1", name: "Old Japanese Film", year: 2005, rating: 4, lang: "ja" }];
  const r = languageEntryPoints(ctxOf(films, { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.equal(r.data.cleanDatedUsed, 0);
  assert.equal(r.finding, "none");
});

// ---- registry integrity ---------------------------------------------

test("one-and-done is blocked rather than shipped without a null model", () => {
  const def = STATS.find((s) => s.id === "one-and-done")!;
  assert.ok(def.blocked, "the raw share is a library-size proxy");
  assert.ok(!IMPLEMENTATIONS["one-and-done"], "and must not be wired up");
});

test("all four new stats survive an empty library", () => {
  const ctx = ctxOf([]);
  for (const stat of [reviewAsymmetry, runtimePrestige, castBlindspot, languageEntryPoints]) {
    const r = stat(ctx);
    const copy = r.finding === "none" ? r.emptyCopy : r.headline;
    assert.ok(copy.length > 20, `${stat.name} produced no sentence`);
    assert.ok(!/undefined|NaN|null|Infinity/.test(copy), `${stat.name}: ${copy}`);
  }
});

test("cast copy describes films-with-an-actor, not repeat viewings", () => {
  const cast = new Map<number, { id: number; name: string; order: number }[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 8; i++) {
    films.push({ id: `m${i}`, name: `Mid ${i}`, rating: 2, tmdbId: 7500 + i });
    cast.set(7500 + i, [{ id: 1, name: "Satya", order: 0 }]);
  }
  for (let i = 0; i < 20; i++) {
    films.push({ id: `g${i}`, name: `Great ${i}`, rating: 5, tmdbId: 8500 + i });
    cast.set(8500 + i, [{ id: 2, name: "Other", order: 0 }]);
  }
  const r = castBlindspot(ctxOf(films, { cast }));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(!/seen Satya \d+ times/.test(copy), `reads as repeat viewings: ${copy}`);
  assert.ok(/appears in 8 films/.test(copy), copy);
});

test("language codes resolve to real names, including ones no hand-list would have", () => {
  // This was a real bug: an Indonesian film rendered as "ID" in live output.
  assert.equal(languageName("id"), "Indonesian");
  assert.equal(languageName("te"), "Telugu");
  assert.equal(languageName("ta"), "Tamil");
  assert.equal(languageName("ml"), "Malayalam");
  assert.equal(languageName("ko"), "Korean");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("fa"), "Persian");
  // ICU names this Filipino rather than Tagalog, and ICU is the authority here.
  assert.equal(languageName("tl"), "Filipino");
  // Overridden because the bare name reads ambiguously in a sentence.
  assert.equal(languageName("en"), "English-language");
  // Unknown or absent codes must not render as a bare two-letter code in prose.
  assert.equal(languageName("??"), "an unknown language");
  assert.equal(languageName(""), "an unknown language");
  // A genuinely unrecognised code degrades to uppercase rather than throwing.
  assert.equal(languageName("zzz"), "ZZZ");
});

test("no stat renders a bare two-letter language code in its copy", () => {
  // Ratings must vary, or tau-b is undefined and the stat declines to name a
  // quadrant — which is correct behaviour, just not what this test is checking.
  const films: Spec[] = [
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `e${i}`, rating: [2, 2.5, 3, 3.5, 4][i % 5]!, lang: "en",
      voteAvg: 5.5 + (i % 20) * 0.1, votes: 5000,
    })),
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `t${i}`, rating: [4, 4.5][i % 2]!, lang: "te",
      voteAvg: 6 + (i % 10) * 0.1, votes: 20,
    })),
  ];
  const r = harshnessSplit(ctxOf(films));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  // A lone uppercase pair mid-sentence is the signature of an unresolved code.
  assert.ok(!/\s[A-Z]{2}\s/.test(copy), `bare code in copy: ${copy}`);
  assert.ok(/Telugu/.test(copy), copy);
});
