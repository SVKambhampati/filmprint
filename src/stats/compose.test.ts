import test from "node:test";
import assert from "node:assert/strict";
import { composePage, IMPLEMENTATIONS } from "./compose.ts";
import { buildContext } from "./context.ts";
import { emptyProfile } from "./profile.ts";
import { normalizeExport, filmKeyFromId } from "../hygiene/normalize.ts";
import { STATS, type SampleProfile } from "./registry.ts";
import type { JoinedFilm } from "../store/types.ts";

function ctxOf(n: number, over: Partial<SampleProfile> = {}) {
  const films = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, rating: [3, 3.5, 4][i % 3]! }));
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...films.map((f) => `2024-01-01,F${f.id},2015,https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: 1000 + i, title: f.id, releaseDate: "2015-01-01",
    runtime: 110, originalLanguage: "en", voteAverage: 7, voteCount: 4000,
    collectionId: null, posterPath: null,
  }));
  const profile: SampleProfile = { ...emptyProfile(), nRated: n, nDistinctFilms: n, nRatedWithCrowd: n, ...over };
  return { ctx: buildContext({ summary, profile, joined }), profile };
}

test("every implementation id corresponds to a declared stat", () => {
  const declared = new Set(STATS.map((s) => s.id));
  for (const id of Object.keys(IMPLEMENTATIONS)) {
    assert.ok(declared.has(id), `${id} is implemented but not declared in the registry`);
  }
});

test("no implementation exists for a blocked stat", () => {
  for (const s of STATS) {
    if (s.blocked) assert.ok(!IMPLEMENTATIONS[s.id], `${s.id} is blocked but wired up anyway`);
  }
});

test("every declared stat lands in exactly one bucket", () => {
  // The durable invariant: a stat can never go missing silently, whatever the
  // ratio of built to unbuilt happens to be.
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  const accounted =
    page.hero.length + page.secondary.length + page.gated.length + page.blocked.length + page.unimplemented.length;
  assert.equal(accounted, STATS.length, "every declared stat must land in exactly one bucket");

  // Anything reported as unbuilt must genuinely have no implementation.
  for (const def of page.unimplemented) {
    assert.ok(!IMPLEMENTATIONS[def.id], `${def.id} is wired up but reported as unbuilt`);
  }
});

test("a null result never takes a hero slot but still appears on the page", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  for (const c of page.hero) assert.notEqual(c.finding, "none", `${c.def.id} is empty but in the hero row`);

  const nulls = page.secondary.filter((c) => c.finding === "none");
  for (const c of nulls) {
    assert.ok(c.copy.length > 20, `${c.def.id} was demoted without copy — that is hiding, not demoting`);
  }
});

test("finding strength outranks editorial score", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  const order = [...page.hero, ...page.secondary].map((c) => c.finding);
  const rank = { strong: 2, weak: 1, none: 0 } as const;
  // Within the composed list, strength must be non-increasing except where the
  // category cap or the relief swap intervened. Check the coarse invariant: no
  // "none" appears before a "strong".
  const firstNone = order.indexOf("none");
  const lastStrong = order.lastIndexOf("strong");
  if (firstNone !== -1 && lastStrong !== -1) {
    assert.ok(firstNone > lastStrong, "an empty stat outranked a strong finding");
  }
  assert.ok(rank.strong > rank.none);
});

test("every composed stat carries copy", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  for (const c of [...page.hero, ...page.secondary]) {
    assert.ok(c.copy.length > 20, `${c.def.id} has no copy`);
    assert.ok(!/undefined|NaN/.test(c.copy), `${c.def.id}: ${c.copy}`);
  }
});

test("an empty library produces a page of gates, not a crash", () => {
  const { ctx, profile } = ctxOf(0);
  const page = composePage(ctx, profile);
  assert.equal(page.hero.length, 0);
  assert.ok(page.gated.length > 0);
});

test("the category cap still applies after finding-strength sorting", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile, { heroCount: 6, maxPerCategory: 1 });
  const seen = new Set<string>();
  for (const c of page.hero) {
    assert.ok(!seen.has(c.def.category), `two ${c.def.category} stats in the hero row`);
    seen.add(c.def.category);
  }
});

test("a stat may correct a title that assumes its conclusion", () => {
  // A user who uses the full scale must not be shown "Your scale has collapsed".
  const buckets = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const films = Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, rating: buckets[i % 10]! }));
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...films.map((f) => `2024-01-01,F${f.id},2015,https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: 2000 + i, title: f.id, releaseDate: "2015-01-01",
    runtime: 110, originalLanguage: "en", voteAverage: 7, voteCount: 4000, collectionId: null, posterPath: null,
  }));
  const profile: SampleProfile = { ...emptyProfile(), nRated: 400, nDistinctFilms: 400, nRatedWithCrowd: 400 };
  const page = composePage(buildContext({ summary, profile, joined }), profile);

  const card = [...page.hero, ...page.secondary].find((c) => c.def.id === "scale-collapse")!;
  assert.notEqual(card.title, card.def.name, "the title must be corrected");
  assert.ok(!/collapsed/i.test(card.title), `title still claims collapse: "${card.title}"`);
  assert.equal(card.tone, "flattering", "good news must not be catalogued as an attack");
});

test("no card's title contradicts its own copy", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  for (const c of [...page.hero, ...page.secondary]) {
    // Crude but effective: a title asserting collapse over copy denying it.
    if (/collapsed/i.test(c.title)) {
      assert.ok(!/actually use your scale/i.test(c.copy), `contradiction on ${c.def.id}`);
    }
  }
});

test("copy reads as complete sentences", () => {
  const { ctx, profile } = ctxOf(500);
  const page = composePage(ctx, profile);
  for (const c of [...page.hero, ...page.secondary]) {
    assert.ok(/[.!?]$/.test(c.copy.trim()), `${c.def.id} copy has no terminal punctuation: "${c.copy}"`);
    // A lowercase word straight after a full stop means two fragments were spliced.
    assert.ok(!/\.\s+[a-z]/.test(c.copy), `${c.def.id} splices a fragment mid-sentence: "${c.copy}"`);
  }
});
