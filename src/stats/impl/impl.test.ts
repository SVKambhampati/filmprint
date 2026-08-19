import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/types.ts";
import { scaleCollapse, MAX_BITS } from "./scale-collapse.ts";
import { harshnessSplit, QUADRANT_MIN_N } from "./harshness-split.ts";
import { tasteCrystallization, PEAK_MIN_BIN_N, chooseBinWidth } from "./taste-crystallization.ts";
import { comfortObject } from "./comfort-object.ts";
import { obscurityLedger } from "./obscurity-ledger.ts";
import { abandonedDiscovery } from "./abandoned-discovery.ts";
import { expectedRating } from "../calibration.ts";
import { percentileRanks } from "../util.ts";

const boxd = (id: string) => `https://boxd.it/${id}`;

/** Build a context directly, without a database. */
function ctxOf(
  films: { id: string; name: string; rating: number; year?: number; runtime?: number; lang?: string; votes?: number; voteAvg?: number; tmdbId?: number }[],
  opts: { diary?: string; genres?: Map<number, string[]>; crew?: Map<number, { id: number; name: string; job: string }[]> } = {},
): StatContext {
  const ratingsCsv = ["Date,Name,Year,Letterboxd URI,Rating",
    ...films.map((f) => `2024-01-01,"${f.name}",${f.year ?? 2020},${boxd(f.id)},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings: ratingsCsv, diary: opts.diary });

  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => {
    joined.set(filmKeyFromId(f.id), {
      filmKey: filmKeyFromId(f.id),
      tmdbId: f.tmdbId ?? 1000 + i,
      title: f.name,
      releaseDate: `${f.year ?? 2020}-01-01`,
      runtime: f.runtime ?? 110,
      originalLanguage: f.lang ?? "en",
      voteAverage: f.voteAvg ?? 7,
      voteCount: f.votes ?? 5000,
      collectionId: null,
      posterPath: `/${f.id}.jpg`,
    });
  });

  return buildContext({
    summary,
    profile: { ...emptyProfile(), nRated: films.length },
    joined,
    genres: opts.genres,
    crew: opts.crew,
  });
}

// ---------------------------------------------------------------------------

test("percentileRanks averages ties instead of inventing an order", () => {
  // Three identical values must all get the same percentile.
  const p = percentileRanks([3, 3, 3, 5]);
  assert.equal(p[0], p[1]);
  assert.equal(p[1], p[2]);
  assert.ok(p[3]! > p[0]!);
  assert.deepEqual(percentileRanks([1, 2]), [0, 1]);
  assert.deepEqual(percentileRanks([7]), [0.5]);
  assert.deepEqual(percentileRanks([]), []);
});

test("scale collapse: the CI contains the estimate at both boundaries", () => {
  // Single value: entropy is 0, the floor. Uniform: entropy is log2(10), the ceiling.
  const onlyThrees = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, rating: 3 }));
  const floor = scaleCollapse(ctxOf(onlyThrees)).data;
  assert.ok(floor.ci.lo <= floor.bitsUsed && floor.bitsUsed <= floor.ci.hi);
  assert.ok(floor.bitsUsed < 0.1, "one value used means ~0 bits");
});

test("scale collapse: a user on two values reads as collapsed", () => {
  const films = Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, rating: i % 2 === 0 ? 3.5 : 4,
  }));
  const s = scaleCollapse(ctxOf(films)).data;
  assert.ok(s.bitsUsed < 1.2, `expected ~1 bit, got ${s.bitsUsed}`);
  assert.equal(s.maxBits, MAX_BITS);
  assert.equal(s.unused.length, 8, "eight of ten values never used");
  assert.ok(s.modalBandShare > 0.99, "everything sits inside the modal band");
});

test("scale collapse: a user using the whole scale does not read as collapsed", () => {
  const buckets = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const films = Array.from({ length: 500 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, rating: buckets[i % 10]!,
  }));
  const s = scaleCollapse(ctxOf(films)).data;
  assert.ok(s.bitsUsed > 3.2, `expected near ${MAX_BITS}, got ${s.bitsUsed}`);
  assert.equal(s.unused.length, 0);
  // At the entropy ceiling the bootstrap interval is one-sided, so the contract
  // is containment rather than strict bracketing.
  assert.ok(s.ci.lo <= s.bitsUsed && s.bitsUsed <= s.ci.hi, "CI must contain the estimate");
});

test("harshness split: a harsh conformist is identified as such", () => {
  // Ratings track the crowd's ORDER exactly but sit well below expectation.
  const films = Array.from({ length: 120 }, (_, i) => {
    const voteAvg = 5 + (i % 30) * 0.1;
    return {
      id: `f${i}`, name: `F${i}`, voteAvg, votes: 3000,
      rating: Math.max(0.5, Math.round((expectedRating(voteAvg) - 1.0) * 2) / 2),
    };
  });
  const h = harshnessSplit(ctxOf(films)).data;
  assert.ok(h.level.offset < -0.5, `should read harsh, got ${h.level.offset}`);
  assert.ok(h.rankAgreement > 0.7, `ordering should match the crowd, got ${h.rankAgreement}`);
  assert.equal(h.quadrant, "harsh conformist");
  assert.ok(h.quadrantTrustworthy);
});

test("harshness split: the quadrant is withheld below the minimum sample", () => {
  const films = Array.from({ length: QUADRANT_MIN_N - 1 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, rating: 3, voteAvg: 7, votes: 3000,
  }));
  const h = harshnessSplit(ctxOf(films)).data;
  assert.equal(h.quadrant, null, "no quadrant claim on thin data");
  assert.equal(h.quadrantTrustworthy, false);
  assert.ok(h.disagreements.length > 0, "but the disagreement list is still fun");
});

test("harshness split: low-vote films are excluded from the comparison", () => {
  const films = [
    ...Array.from({ length: 70 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, rating: 3.5, voteAvg: 7, votes: 5000 })),
    { id: "obscure", name: "Obscure", rating: 5, voteAvg: 9.9, votes: 3 },
  ];
  const h = harshnessSplit(ctxOf(films)).data;
  assert.equal(h.n, 70, "the 3-vote film must not manufacture disagreement");
  assert.ok(!h.disagreements.some((d) => d.name === "Obscure"));
});

test("taste crystallization: a real peak is found", () => {
  const films = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, year: 2007, rating: 4.5 })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, year: 1997, rating: 2.5 })),
    ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, year: 2017, rating: 3.0 })),
  ];
  const t = tasteCrystallization(ctxOf(films)).data;
  assert.ok(t.peak, "a 2-star gap must produce a peak");
  // 40 films in each of three years clears BIN_SELECT_MIN_MEDIAN, so 1-year bins
  // are justified here and the peak is the year itself.
  assert.equal(t.binWidth, 1);
  assert.equal(t.peak!.year, 2007);
  assert.equal(t.peak!.topFilms.length, 3);
});

test("taste crystallization: a flat profile refuses to invent a peak", () => {
  const films = Array.from({ length: 150 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 1990 + (i % 30), rating: 3.5,
  }));
  const t = tasteCrystallization(ctxOf(films)).data;
  assert.equal(t.peak, null);
  assert.ok(t.noPeakReason?.includes("inside the noise"), t.noPeakReason ?? "no reason given");
});

test("taste crystallization: thin bins cannot become peaks", () => {
  const films = Array.from({ length: PEAK_MIN_BIN_N - 1 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 1975, rating: 5,
  }));
  const t = tasteCrystallization(ctxOf(films)).data;
  assert.equal(t.peak, null, "a handful of 5s is not an era");
  assert.ok(t.noPeakReason?.includes("rated films"));
});

test("obscurity ledger: cohort normalisation stops 'you watch old foreign films'", () => {
  // Two cohorts. Within each, one film is genuinely under-voted.
  const modern = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, name: `Modern ${i}`, year: 2015, lang: "en", rating: 4.5,
    votes: i === 0 ? 40 : 8000,
  }));
  const old = Array.from({ length: 20 }, (_, i) => ({
    id: `o${i}`, name: `Old ${i}`, year: 1975, lang: "ja", rating: 4.5,
    votes: i === 0 ? 12 : 400,
  }));
  const led = obscurityLedger(ctxOf([...modern, ...old])).data;
  const names = led.finds.map((f) => f.name);
  assert.ok(names.includes("Modern 0"), "the under-voted modern film should surface");
  assert.ok(names.includes("Old 0"), "the under-voted old film should surface");
  // A well-voted 1975 Japanese film must NOT rank as a find just for being old.
  const old5 = led.finds.find((f) => f.name === "Old 5");
  assert.ok(!old5 || old5.cohortZ > -1, "typical-for-its-cohort is not obscure");
});

test("obscurity ledger: only highly-rated films count as finds", () => {
  const films = Array.from({ length: 20 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 2015, rating: i === 0 ? 4.5 : 2.0, votes: i === 0 ? 30 : 9000,
  }));
  const led = obscurityLedger(ctxOf(films)).data;
  assert.equal(led.candidates, 1, "a badly-rated obscure film is not a find");
  assert.equal(led.finds[0]!.name, "F0");
});

test("obscurity ledger: a cohort too small to judge is counted, not guessed at", () => {
  const films = [{ id: "solo", name: "Solo", year: 1930, lang: "sv", rating: 5, votes: 5 }];
  const led = obscurityLedger(ctxOf(films)).data;
  assert.equal(led.finds.length, 0);
  assert.equal(led.uncohorted, 1);
});

test("comfort object: reports the most-rewatched film as a lower bound", () => {
  const diary = ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date",
    ...Array.from({ length: 12 }, (_, i) =>
      `2026-0${(i % 9) + 1}-15,Salaar,2023,${boxd(`czv${i}`)},4.5,Yes,,2026-0${(i % 9) + 1}-1${i % 5}`),
    `2024-01-05,New Film,2024,${boxd("czvNEW")},3.5,,,2024-01-04`,
  ].join("\n");

  const c = comfortObject(ctxOf([
    { id: "salaarF", name: "Salaar", year: 2023, rating: 4.5, runtime: 175 },
    { id: "newF", name: "New Film", year: 2024, rating: 3.5, runtime: 95 },
  ], { diary })).data;

  assert.equal(c.top!.name, "Salaar");
  assert.ok(c.top!.atLeastTimes >= 9, `expected a lower bound of 9+, got ${c.top!.atLeastTimes}`);
  assert.ok(c.seeking && c.returning, "12 rewatches is enough for the profile split");
});

test("comfort object: too few rewatches yields the top film but no profile", () => {
  const diary = ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date",
    `2026-01-15,Salaar,2023,${boxd("czv1")},4.5,Yes,,2026-01-14`].join("\n");
  const c = comfortObject(ctxOf([{ id: "s", name: "Salaar", year: 2023, rating: 4.5 }], { diary })).data;
  assert.equal(c.top!.name, "Salaar");
  assert.equal(c.seeking, null, "one rewatch cannot support a profile comparison");
});

test("abandoned discovery: loved once, never revisited", () => {
  const crew = new Map([
    [1000, [{ id: 1, name: "Loved Once", job: "Director" }]],
    [1001, [{ id: 2, name: "Seen Twice", job: "Director" }]],
    [1002, [{ id: 2, name: "Seen Twice", job: "Director" }]],
    [1003, [{ id: 3, name: "Disliked", job: "Director" }]],
  ]);
  const films = [
    { id: "a", name: "Great Film", rating: 5, tmdbId: 1000 },
    { id: "b", name: "Good One", rating: 4.5, tmdbId: 1001 },
    { id: "c", name: "Good Two", rating: 4.5, tmdbId: 1002 },
    { id: "d", name: "Bad Film", rating: 2, tmdbId: 1003 },
  ];
  const out = abandonedDiscovery(ctxOf(films, { crew })).data;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.director, "Loved Once");
  assert.equal(out[0]!.filmographySize, null, "honest about the un-enriched field");
});

test("every hero stat survives an empty library without throwing", () => {
  const ctx = ctxOf([]);
  assert.equal(scaleCollapse(ctx).data.n, 0);
  assert.equal(harshnessSplit(ctx).data.quadrant, null);
  assert.equal(tasteCrystallization(ctx).data.peak, null);
  assert.equal(comfortObject(ctx).data.top, null);
  assert.equal(obscurityLedger(ctx).data.finds.length, 0);
  assert.deepEqual(abandonedDiscovery(ctx).data, []);
});

test("every stat produces a sentence, in both branches of the contract", () => {
  const empty = ctxOf([]);
  const full = ctxOf(Array.from({ length: 200 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, rating: [3, 3.5, 4][i % 3]!, year: 2010 + (i % 5), votes: 4000,
  })));

  for (const stat of [scaleCollapse, harshnessSplit, tasteCrystallization, comfortObject, obscurityLedger, abandonedDiscovery]) {
    for (const [label, ctx] of [["empty", empty], ["full", full]] as const) {
      const r = stat(ctx);
      const copy = r.finding === "none" ? r.emptyCopy : r.headline;
      assert.ok(copy.length > 20, `${stat.name} on ${label} library produced no usable sentence`);
      assert.ok(!copy.includes("undefined"), `${stat.name} on ${label}: "${copy}"`);
      assert.ok(!copy.includes("NaN"), `${stat.name} on ${label}: "${copy}"`);
      assert.ok(!copy.includes("null"), `${stat.name} on ${label}: "${copy}"`);
    }
  }
});

test("a null result is phrased as the finding it actually is", () => {
  // Every 4.5 is a popular film: the ledger has nothing, and must say why.
  const films = Array.from({ length: 20 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 2015, rating: 4.5, votes: 9000,
  }));
  const r = obscurityLedger(ctxOf(films));
  assert.equal(r.finding, "none");
  if (r.finding !== "none") return;
  assert.ok(/no obscure favourites|everyone loves/i.test(r.emptyCopy), r.emptyCopy);
});

test("finding strength is self-assessed, not inferred from sample size", () => {
  // A big library with a flat era profile: plenty of data, weak finding.
  const flat = ctxOf(Array.from({ length: 400 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 1990 + (i % 20), rating: 3.5,
  })));
  assert.equal(tasteCrystallization(flat).finding, "weak", "no peak is a weak finding, not a strong one");

  // Same size library, real peak.
  const peaked = ctxOf([
    ...Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, year: 2007, rating: 5 })),
    ...Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, year: 1997, rating: 2 })),
  ]);
  assert.equal(tasteCrystallization(peaked).finding, "strong");
});

test("obscurity ledger refuses to call a well-voted film a find", () => {
  // 20 films rated 4.5, all typical for their cohort. None is a find.
  const films = Array.from({ length: 20 }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, year: 2015, rating: 4.5, votes: 8000 + i * 10,
  }));
  const led = obscurityLedger(ctxOf(films)).data;
  assert.equal(led.finds.length, 0, "nothing here is obscure");
  assert.equal(led.notObscureEnough, 20, "and the stat says so instead of faking it");
});

test("obscurity ledger surfaces only films below the qualifying threshold", () => {
  const films = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, name: `Normal ${i}`, year: 2015, rating: 4.5, votes: 8000 })),
    { id: "rare", name: "Genuinely Rare", year: 2015, rating: 4.5, votes: 20 },
  ];
  const led = obscurityLedger(ctxOf(films)).data;
  assert.equal(led.finds.length, 1);
  assert.equal(led.finds[0]!.name, "Genuinely Rare");
  assert.ok(led.finds[0]!.cohortZ < -0.5);
});

test("bin width is chosen by films per bin, not library size", () => {
  // 1,800 films spread over a century is ~18/year -- thin per YEAR despite a big
  // library, so a wider bin must be chosen.
  // ~18 films per year: below the median needed to trust 1-year bins.
  const wide = Array.from({ length: 1800 }, (_, i) => 1920 + (i % 100));
  assert.equal(chooseBinWidth(wide), 5, "should widen to 5-year bins");

  // 1,800 films across ten years is ~180/year -- 1-year bins are justified.
  const dense = Array.from({ length: 1800 }, (_, i) => 2015 + (i % 10));
  assert.equal(chooseBinWidth(dense), 1);

  assert.equal(chooseBinWidth([]), 20, "no data falls back to the coarsest bin");
});

test("a co-directed film appears once, with co-directors listed", () => {
  const crew = new Map([
    [1000, [
      { id: 1, name: "Director A", job: "Director" },
      { id: 2, name: "Director B", job: "Director" },
      { id: 3, name: "Director C", job: "Director" },
    ]],
  ]);
  const out = abandonedDiscovery(ctxOf([{ id: "a", name: "Spider-Verse", rating: 4.5, tmdbId: 1000 }], { crew })).data;
  assert.equal(out.length, 1, "one film, one entry");
  assert.equal(out[0]!.coDirectors?.length, 2, "the other two are listed as co-directors");
});

test("harshness reports what the vote-count filter cost, and where", () => {
  // 100 English films with plenty of votes, 100 Telugu films with almost none.
  // The filter keeps only the English half, which is exactly the bias to disclose.
  const en = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i}`, name: `EN ${i}`, lang: "en", rating: 3, voteAvg: 7, votes: 5000,
  }));
  const te = Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`, name: `TE ${i}`, lang: "te", rating: 4.5, voteAvg: 7, votes: 12,
  }));
  const d = harshnessSplit(ctxOf([...en, ...te])).data;

  assert.equal(d.coverage.rated, 200);
  assert.equal(d.coverage.compared, 100);
  assert.equal(d.coverage.excluded, 100);
  assert.ok(Math.abs(d.coverage.share - 0.5) < 1e-9);
  assert.equal(d.coverage.worstExcluded[0]!.language, "te", "Telugu lost the most films");
  assert.equal(d.coverage.worstExcluded[0]!.excluded, 100);
});

test("harshness discloses low coverage in its copy", () => {
  // Ratings and crowd scores must both VARY, or tau-b is undefined and the stat
  // correctly declines to name a quadrant.
  const en = Array.from({ length: 100 }, (_, i) => {
    const voteAvg = 5.5 + (i % 25) * 0.1;
    return {
      id: `e${i}`, name: `EN ${i}`, lang: "en", voteAvg, votes: 5000,
      rating: Math.max(0.5, Math.round((expectedRating(voteAvg) - 0.8) * 2) / 2),
    };
  });
  const te = Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`, name: `TE ${i}`, lang: "te", rating: 4.5, voteAvg: 6 + (i % 10) * 0.1, votes: 12,
  }));
  const r = harshnessSplit(ctxOf([...en, ...te]));
  assert.equal(r.finding, "strong");
  assert.ok(/100 of your 200 rated films/.test(r.headline), r.headline);
  assert.ok(/Telugu/.test(r.headline), "must name where the loss fell: " + r.headline);
});

test("harshness splits by language and headlines a real divergence", () => {
  // Harsh on English, generous on Hindi. Crowd scores vary within each group so
  // rank correlation is defined.
  const group = (prefix: string, lang: string, shift: number) =>
    Array.from({ length: 60 }, (_, i) => {
      const voteAvg = 6.0 + (i % 20) * 0.1;
      return {
        id: `${prefix}${i}`, name: `${prefix.toUpperCase()} ${i}`, lang, voteAvg, votes: 5000,
        rating: Math.min(5, Math.max(0.5, Math.round((expectedRating(voteAvg) + shift) * 2) / 2)),
      };
    });

  const r = harshnessSplit(ctxOf([...group("e", "en", -1.0), ...group("h", "hi", 1.0)]));
  const d = r.data;

  assert.equal(d.byLanguage.length, 2);
  assert.ok(d.divergence, "a 2-star gap between languages must be detected");
  assert.equal(d.divergence!.harsher.language, "en");
  assert.equal(d.divergence!.kinder.language, "hi");
  assert.ok(d.divergence!.gap > 1.5, `expected a large gap, got ${d.divergence!.gap}`);
  assert.equal(r.finding, "strong");
  assert.ok(/harsher on English-language films than on Hindi/.test(r.headline), r.headline);
});

test("a language below the minimum sample gets no verdict of its own", () => {
  const en = Array.from({ length: 80 }, (_, i) => ({
    id: `e${i}`, name: `EN ${i}`, lang: "en", rating: 3, voteAvg: 7, votes: 5000,
  }));
  // Only 10 French films: too few to judge separately.
  const fr = Array.from({ length: 10 }, (_, i) => ({
    id: `f${i}`, name: `FR ${i}`, lang: "fr", rating: 5, voteAvg: 7, votes: 5000,
  }));
  const d = harshnessSplit(ctxOf([...en, ...fr])).data;
  assert.deepEqual(d.byLanguage.map((l) => l.language), ["en"]);
  assert.equal(d.divergence, null, "one group cannot diverge from itself");
});

test("uniform coverage produces no disclosure clause", () => {
  const films = Array.from({ length: 120 }, (_, i) => ({
    id: `f${i}`, name: `F ${i}`, lang: "en", rating: 3, voteAvg: 7, votes: 5000,
  }));
  const r = harshnessSplit(ctxOf(films));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(!/rests on/.test(copy), "nothing was excluded, so say nothing: " + copy);
});
