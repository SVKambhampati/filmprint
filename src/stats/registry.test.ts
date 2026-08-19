import test from "node:test";
import assert from "node:assert/strict";
import {
  STATS,
  judge,
  selectStats,
  scoreOf,
  headroomOf,
  type StatDefinition,
  type SampleProfile,
} from "./registry.ts";
import { emptyProfile } from "./profile.ts";

const profile = (over: Partial<SampleProfile> = {}): SampleProfile => ({ ...emptyProfile(), ...over });

const def = (over: Partial<StatDefinition> & { id: string }): StatDefinition => ({
  name: over.id,
  category: "taste",
  revealing: 3,
  shareable: 3,
  tone: "neutral",
  requires: [],
  ...over,
});

test("the registry itself is well-formed", () => {
  const ids = new Set<string>();
  for (const s of STATS) {
    assert.ok(!ids.has(s.id), `duplicate stat id: ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name.length > 0, `${s.id} has no name`);
    assert.ok(s.revealing >= 1 && s.revealing <= 5, `${s.id} revealing out of range`);
    assert.ok(s.shareable >= 1 && s.shareable <= 5, `${s.id} shareable out of range`);
    for (const r of s.requires) assert.ok(r.min > 0, `${s.id} has a zero-minimum requirement`);
  }
  assert.ok(STATS.length >= 25, "the spec defined ~28 stats");
});

test("a blocked stat can never be selected, no matter how much data exists", () => {
  // Every metric maxed out.
  const huge = profile(
    Object.fromEntries(Object.keys(emptyProfile()).map((k) => [k, 100_000])) as SampleProfile,
  );
  const sel = selectStats(huge);
  const blockedIds = new Set(sel.blocked.map((b) => b.def.id));
  assert.ok(blockedIds.size > 0, "the registry should contain blocked stats");
  for (const d of [...sel.hero, ...sel.secondary]) {
    assert.ok(!blockedIds.has(d.id), `${d.id} is blocked but was selected`);
  }
  // Named individually only where the blocker is genuinely unresolved work, so
  // this test does not have to change every time one gets unblocked.
  assert.ok(blockedIds.has("studio-capture"), "needs a curated company allow-list");
  assert.ok(blockedIds.has("one-and-done"), "needs a films-per-director reference distribution");

  // Every blocked stat must explain itself, or the block is undebuggable later.
  for (const b of sel.blocked) {
    assert.ok(b.reason.length > 40, `${b.def.id} is blocked without a usable reason`);
  }
});

test("gated stats report exactly what they are missing", () => {
  const v = judge(
    def({ id: "x", requires: [{ metric: "nRated", min: 100 }, { metric: "nWatchlist", min: 25 }] }),
    profile({ nRated: 150, nWatchlist: 21 }),
  );
  assert.equal(v.status, "gated");
  if (v.status !== "gated") return;
  assert.equal(v.missing.length, 1, "only the unmet requirement is reported");
  assert.deepEqual(v.missing[0], { metric: "nWatchlist", min: 25, have: 21 });
});

test("headroom rewards comfortable margins and saturates", () => {
  const d = def({ id: "x", requires: [{ metric: "nRated", min: 100 }] });
  assert.ok(headroomOf(d, profile({ nRated: 100 })) < headroomOf(d, profile({ nRated: 300 })));
  // Saturates at 3x so an enormous library does not swamp editorial ranking.
  assert.equal(headroomOf(d, profile({ nRated: 300 })), headroomOf(d, profile({ nRated: 30_000 })));
  // The weakest requirement governs.
  const two = def({ id: "y", requires: [{ metric: "nRated", min: 10 }, { metric: "nWatchlist", min: 100 }] });
  assert.ok(headroomOf(two, profile({ nRated: 10_000, nWatchlist: 100 })) < 0.4);
});

test("score ranks by revealing x shareable, modulated by headroom", () => {
  const strong = def({ id: "a", revealing: 5, shareable: 5, requires: [{ metric: "nRated", min: 10 }] });
  const weak = def({ id: "b", revealing: 2, shareable: 2, requires: [{ metric: "nRated", min: 10 }] });
  const p = profile({ nRated: 1000 });
  assert.ok(scoreOf(strong, p) > scoreOf(weak, p));
  // Headroom cannot flip a large quality gap.
  assert.ok(scoreOf(strong, profile({ nRated: 10 })) > scoreOf(weak, profile({ nRated: 10_000 })));
});

test("the hero row is capped per category so it isn't six versions of one idea", () => {
  const defs = Array.from({ length: 8 }, (_, i) =>
    def({ id: `taste-${i}`, category: "taste", revealing: 5, shareable: 5 }),
  );
  const sel = selectStats(profile({ nRated: 1000 }), defs, { heroCount: 6, maxPerCategory: 2 });
  assert.equal(sel.hero.length, 2, "only 2 of a single category may be heroes");
  assert.equal(sel.secondary.length, 6);
});

test("the page is never entirely unflattering", () => {
  const defs = [
    def({ id: "mean-1", category: "crowd", tone: "unflattering", revealing: 5, shareable: 5 }),
    def({ id: "mean-2", category: "taste", tone: "unflattering", revealing: 5, shareable: 5 }),
    def({ id: "kind-1", category: "discovery", tone: "flattering", revealing: 1, shareable: 1 }),
  ];
  const sel = selectStats(profile({ nRated: 1000 }), defs, { heroCount: 2, maxPerCategory: 2 });
  assert.equal(sel.hero.length, 2);
  assert.ok(
    sel.hero.some((d) => d.tone !== "unflattering"),
    "a page of pure attacks needs at least one point of relief",
  );
  // And the displaced stat is not lost, just demoted.
  assert.ok(sel.secondary.some((d) => d.id.startsWith("mean")));
});

test("relief is not forced when the page already has some", () => {
  const defs = [
    def({ id: "mean-1", category: "crowd", tone: "unflattering", revealing: 5, shareable: 5 }),
    def({ id: "neutral-1", category: "taste", tone: "neutral", revealing: 5, shareable: 4 }),
    def({ id: "kind-1", category: "discovery", tone: "flattering", revealing: 1, shareable: 1 }),
  ];
  const sel = selectStats(profile({ nRated: 1000 }), defs, { heroCount: 2, maxPerCategory: 2 });
  assert.deepEqual(sel.hero.map((d) => d.id), ["mean-1", "neutral-1"], "no swap needed");
});

test("an empty profile yields an empty page rather than a broken one", () => {
  const sel = selectStats(emptyProfile());
  assert.equal(sel.hero.length, 0);
  assert.equal(sel.secondary.length, 0);
  assert.ok(sel.gated.length > 0, "everything should be gated, with reasons");
  assert.equal(sel.verdicts.length, STATS.length, "every stat gets a verdict");
});

test("a rating-first backlogger gets a full page from taste stats alone", () => {
  // The real shape: thousands of ratings, almost no usable dates, tiny watchlist.
  const sel = selectStats(
    profile({
      nRated: 1868, nWatched: 1868, nDistinctFilms: 1889, nRatedWithCrowd: 1600,
      nDiary: 100, nCleanDated: 79, nWatchlist: 21, nWatchlistReleased: 3,
      nRewatchEntries: 34, nTaggedEntries: 0,
    }),
  );
  assert.ok(sel.hero.length >= 5, `expected a full hero row, got ${sel.hero.length}`);
  // The date-starved stats must be gated, not rendered on 79 entries.
  const gatedIds = new Set(sel.gated.map((g) => g.def.id));
  assert.ok(gatedIds.has("log-lag"), "lag needs 100 clean-dated");
  // Renamed from watchlist-half-life: time-to-watch is not computable from an
  // export, so the stat is an age list gated on RELEASED watchlist films.
  assert.ok(gatedIds.has("watchlist-graveyard"), "the graveyard needs released watchlist films");
});

test("a diary-first logger gets a different page than a rating-first one", () => {
  const ratingFirst = selectStats(
    profile({ nRated: 1868, nDistinctFilms: 1889, nRatedWithCrowd: 1600, nDiary: 100, nCleanDated: 79, nWatchlist: 21 }),
  );
  const diaryFirst = selectStats(
    profile({
      nRated: 400, nDistinctFilms: 400, nRatedWithCrowd: 350, nDiary: 600, nCleanDated: 560,
      nWatchlist: 80, nRewatchEntries: 60, nPairedRewatch: 25, nReviews: 90, nTaggedEntries: 40, nYearsWithData: 3,
    }),
  );
  const a = ratingFirst.hero.map((d) => d.id).join(",");
  const b = diaryFirst.hero.map((d) => d.id).join(",");
  assert.notEqual(a, b, "the page must adapt to logging style — that is the whole point");
  assert.ok(
    diaryFirst.hero.some((d) => d.category === "behaviour"),
    "a heavy logger should see behaviour stats a backlogger cannot",
  );
});

test("a light new user still gets something rather than a blank screen", () => {
  const sel = selectStats(profile({ nRated: 45, nWatched: 50, nDistinctFilms: 50, nDiary: 30, nCleanDated: 28 }));
  assert.ok(sel.hero.length >= 3, `a 45-film user should still get a page, got ${sel.hero.length}`);
  assert.ok(
    sel.hero.some((d) => d.id === "bulk-log-confession" || d.id === "abandoned-discovery" || d.id === "half-star-tell"),
    "the low-n survival kit should surface",
  );
});

test("every non-blocked stat is reachable by some plausible profile", () => {
  // Guards against a requirement typo that quietly makes a stat impossible.
  const generous = profile(
    Object.fromEntries(Object.keys(emptyProfile()).map((k) => [k, 5000])) as SampleProfile,
  );
  const sel = selectStats(generous, STATS, { heroCount: 6, maxPerCategory: 99 });
  const reachable = new Set([...sel.hero, ...sel.secondary].map((d) => d.id));
  for (const s of STATS) {
    if (s.blocked) continue;
    assert.ok(reachable.has(s.id), `${s.id} is unreachable — check its requirements`);
  }
});
