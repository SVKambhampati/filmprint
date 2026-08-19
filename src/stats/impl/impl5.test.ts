import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/db.ts";
import { invisibleSignature, CREW_MIN_FILMS, MIN_DISTINCT_DIRECTORS, KEYWORD_BLOCKLIST } from "./invisible-signature.ts";
import { ratingSeasonality, MONTH_MIN_N } from "./rating-seasonality.ts";
import { IMPLEMENTATIONS } from "../compose.ts";
import { STATS } from "../registry.ts";

type Crew = { id: number; name: string; job: string };
type Spec = { id: string; name?: string; rating?: number; year?: number; tmdbId?: number };

function ctxOf(
  films: Spec[],
  opts: { diary?: string; crew?: Map<number, Crew[]>; keywords?: Map<number, string[]> } = {},
): StatContext {
  const rated = films.filter((f) => f.rating != null);
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...rated.map((f) => `2024-01-01,"${f.name ?? f.id}",${f.year ?? 2015},https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const summary = normalizeExport({ ratings, diary: opts.diary });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: f.tmdbId ?? 1000 + i, title: f.name ?? f.id,
    releaseDate: `${f.year ?? 2015}-01-01`, runtime: 110, originalLanguage: "en",
    voteAverage: 7, voteCount: 4000, collectionId: null, posterPath: null,
  }));
  return buildContext({
    summary, profile: { ...emptyProfile(), nRated: rated.length }, joined,
    crew: opts.crew, keywords: opts.keywords,
  });
}

const DIARY_HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";

// ---- invisible signature -----------------------------------------------

test("a DoP spanning several directors qualifies as a signature", () => {
  const crew = new Map<number, Crew[]>();
  const films: Spec[] = [];
  // Five films with one DoP, each under a DIFFERENT director, all rated highly.
  for (let i = 0; i < 5; i++) {
    films.push({ id: `s${i}`, name: `Sig ${i}`, rating: 5, tmdbId: 3000 + i });
    crew.set(3000 + i, [
      { id: 900, name: "Great DoP", job: "Director of Photography" },
      { id: 100 + i, name: `Director ${i}`, job: "Director" },
    ]);
  }
  // A baseline of mediocre films so the lift is real.
  for (let i = 0; i < 40; i++) {
    films.push({ id: `b${i}`, rating: 3, tmdbId: 4000 + i });
    crew.set(4000 + i, [{ id: 200, name: "Someone", job: "Director" }]);
  }
  const r = invisibleSignature(ctxOf(films, { crew }));
  assert.equal(r.data.signatures[0]!.name, "Great DoP");
  assert.equal(r.data.signatures[0]!.distinctDirectors, 5);
  assert.ok(r.data.signatures[0]!.lift > 0.25);
  assert.equal(r.finding, "strong");
});

test("a DoP tied to ONE director is rejected as a director stat in disguise", () => {
  // The exact failure mode: six films, one DoP, one director. Deakins-and-
  // Villeneuve. Must not be presented as a hidden preference.
  const crew = new Map<number, Crew[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 6; i++) {
    films.push({ id: `v${i}`, name: `V ${i}`, rating: 5, tmdbId: 5000 + i });
    crew.set(5000 + i, [
      { id: 901, name: "Roger Deakins", job: "Director of Photography" },
      { id: 300, name: "Denis Villeneuve", job: "Director" },
    ]);
  }
  for (let i = 0; i < 40; i++) {
    films.push({ id: `b${i}`, rating: 3, tmdbId: 6000 + i });
    crew.set(6000 + i, [{ id: 400, name: "Other", job: "Director" }]);
  }
  const r = invisibleSignature(ctxOf(films, { crew }));
  assert.ok(!r.data.signatures.some((s) => s.name === "Roger Deakins"), "must be rejected");
  assert.equal(r.data.rejectedAsDirectorProxy[0]!.name, "Roger Deakins");
  assert.equal(r.data.rejectedAsDirectorProxy[0]!.distinctDirectors, 1);
  // And the copy must explain WHY rather than showing an empty card.
  assert.equal(r.finding, "none");
  assert.ok(/taste in directors showing through/.test(r.emptyCopy), r.emptyCopy);
});

test("two directors is still not enough to clear the proxy test", () => {
  const crew = new Map<number, Crew[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 6; i++) {
    films.push({ id: `t${i}`, rating: 5, tmdbId: 7000 + i });
    crew.set(7000 + i, [
      { id: 902, name: "Borderline DoP", job: "Director of Photography" },
      { id: 500 + (i % (MIN_DISTINCT_DIRECTORS - 1)), name: `D${i % 2}`, job: "Director" },
    ]);
  }
  for (let i = 0; i < 40; i++) {
    films.push({ id: `b${i}`, rating: 3, tmdbId: 8000 + i });
    crew.set(8000 + i, [{ id: 600, name: "Other", job: "Director" }]);
  }
  const r = invisibleSignature(ctxOf(films, { crew }));
  assert.ok(!r.data.signatures.some((s) => s.name === "Borderline DoP"));
});

test("fewer than the minimum films means no verdict at all", () => {
  const crew = new Map<number, Crew[]>();
  const films: Spec[] = [];
  for (let i = 0; i < CREW_MIN_FILMS - 1; i++) {
    films.push({ id: `f${i}`, rating: 5, tmdbId: 9000 + i });
    crew.set(9000 + i, [
      { id: 903, name: "Barely There", job: "Director of Photography" },
      { id: 700 + i, name: `D${i}`, job: "Director" },
    ]);
  }
  const r = invisibleSignature(ctxOf(films, { crew }));
  assert.equal(r.data.signatures.length, 0);
  assert.equal(r.data.rejectedAsDirectorProxy.length, 0, "not rejected — just not enough films");
});

test("packaging keywords can never become a theme", () => {
  const keywords = new Map<number, string[]>();
  const films: Spec[] = [];
  for (let i = 0; i < 20; i++) {
    films.push({ id: `k${i}`, rating: 5, tmdbId: 2000 + i });
    keywords.set(2000 + i, ["aftercreditsstinger", "based on novel or book", "woman director", "grief"]);
  }
  for (let i = 0; i < 40; i++) {
    films.push({ id: `b${i}`, rating: 3, tmdbId: 2500 + i });
    keywords.set(2500 + i, ["aftercreditsstinger"]);
  }
  const r = invisibleSignature(ctxOf(films, { keywords }));
  const themeNames = r.data.themes.map((t) => t.keyword);
  for (const blocked of ["aftercreditsstinger", "based on novel or book", "woman director"]) {
    assert.ok(!themeNames.includes(blocked), `${blocked} must be filtered out`);
  }
  assert.ok(themeNames.includes("grief"), "a real theme should survive");
});

test("the blocklist covers the tags that appear on nearly every film", () => {
  for (const k of ["aftercreditsstinger", "duringcreditsstinger", "woman director", "sequel", "remake", "imax"]) {
    assert.ok(KEYWORD_BLOCKLIST.has(k), `${k} should be blocked`);
  }
});

// ---- rating seasonality -----------------------------------------------

test("seasonality reports NO finding when the swing is noise", () => {
  // Ratings assigned independently of month: any range is selection artifact.
  const rows: string[] = [];
  let n = 0;
  for (let month = 1; month <= 12; month++) {
    for (let i = 0; i < 30; i++) {
      const day = String((i % 27) + 1).padStart(2, "0");
      const mm = String(month).padStart(2, "0");
      const rating = [2, 2.5, 3, 3.5, 4][(n + month) % 5]!;
      rows.push(`2025-${mm}-${day},F${n},2015,https://boxd.it/czv${n},${rating},,,2025-${mm}-${day}`);
      n++;
    }
  }
  const r = ratingSeasonality(ctxOf([], { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.equal(r.data.months.length, 12, "all twelve months estimated");
  assert.equal(r.data.significant, false, `noise must not survive, p=${r.data.p}`);
  assert.equal(r.finding, "none");
  assert.ok(/does not survive testing/.test(r.emptyCopy), r.emptyCopy);
});

test("seasonality reports a finding when the effect is real and large", () => {
  // December genuinely a full star higher than every other month.
  const rows: string[] = [];
  let n = 0;
  for (let month = 1; month <= 12; month++) {
    for (let i = 0; i < 30; i++) {
      const day = String((i % 27) + 1).padStart(2, "0");
      const mm = String(month).padStart(2, "0");
      const base = month === 12 ? 4.5 : 3;
      const rating = Math.min(5, base + (i % 2) * 0.5);
      rows.push(`2025-${mm}-${day},F${n},2015,https://boxd.it/czv${n},${rating},,,2025-${mm}-${day}`);
      n++;
    }
  }
  const r = ratingSeasonality(ctxOf([], { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.ok(r.data.significant, `a full-star December should survive, p=${r.data.p}`);
  assert.equal(r.data.best!.label, "December");
  assert.equal(r.finding, "strong");
  assert.ok(/survives testing/.test(r.headline), r.headline);
});

test("seasonality excludes backfilled entries and says how many", () => {
  // All logged years after watching: unusable for a calendar stat.
  const rows = Array.from({ length: 60 }, (_, i) => {
    const mm = String((i % 12) + 1).padStart(2, "0");
    return `2026-08-01,F${i},2015,https://boxd.it/czv${i},4,,,2019-${mm}-15`;
  });
  const r = ratingSeasonality(ctxOf([], { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.equal(r.data.n, 0, "nothing clean-dated survives");
  assert.ok(r.data.excluded >= 60);
  assert.equal(r.finding, "none");
  assert.ok(/backfilled or bulk-imported/.test(r.emptyCopy), r.emptyCopy);
});

test("a month below the minimum sample is not estimated", () => {
  const rows: string[] = [];
  // January has plenty; February has three.
  for (let i = 0; i < 30; i++) rows.push(`2025-01-${String((i % 27) + 1).padStart(2, "0")},A${i},2015,https://boxd.it/czvA${i},4,,,2025-01-${String((i % 27) + 1).padStart(2, "0")}`);
  for (let i = 0; i < 3; i++) rows.push(`2025-02-0${i + 1},B${i},2015,https://boxd.it/czvB${i},1,,,2025-02-0${i + 1}`);
  const r = ratingSeasonality(ctxOf([], { diary: [DIARY_HEADER, ...rows].join("\n") }));
  assert.deepEqual(r.data.months.map((m) => m.label), ["January"], `February had fewer than ${MONTH_MIN_N}`);
  assert.equal(r.finding, "none", "one month cannot show seasonality");
});

// ---- registry integrity ---------------------------------------------

test("the two unblocked stats are wired and no longer blocked", () => {
  for (const id of ["invisible-signature", "rating-seasonality"]) {
    const def = STATS.find((s) => s.id === id)!;
    assert.ok(!def.blocked, `${id} should no longer be blocked`);
    assert.ok(IMPLEMENTATIONS[id], `${id} should be wired up`);
    assert.ok(def.caveat, `${id} must carry the caveat its hazard demands`);
  }
});

test("the still-blocked stats remain blocked and unwired", () => {
  // These two need work that does not exist yet, and must not slip through.
  for (const id of ["studio-capture", "one-and-done"]) {
    const def = STATS.find((s) => s.id === id)!;
    assert.ok(def.blocked, `${id} must stay blocked`);
    assert.ok(!IMPLEMENTATIONS[id], `${id} must stay unwired`);
  }
});

test("both new stats survive an empty library", () => {
  const ctx = ctxOf([]);
  for (const stat of [invisibleSignature, ratingSeasonality]) {
    const r = stat(ctx);
    const copy = r.finding === "none" ? r.emptyCopy : r.headline;
    assert.ok(copy.length > 20, `${stat.name} produced no sentence`);
    assert.ok(!/undefined|NaN|null|Infinity/.test(copy), `${stat.name}: ${copy}`);
  }
});

test("signature copy uses the verb that matches the job", () => {
  const build = (job: string) => {
    const crew = new Map<number, Crew[]>();
    const films: Spec[] = [];
    for (let i = 0; i < 5; i++) {
      films.push({ id: `s${i}`, name: `Sig ${i}`, rating: 5, tmdbId: 3300 + i });
      crew.set(3300 + i, [
        { id: 950, name: "The Person", job },
        { id: 150 + i, name: `Director ${i}`, job: "Director" },
      ]);
    }
    for (let i = 0; i < 40; i++) {
      films.push({ id: `b${i}`, rating: 3, tmdbId: 4400 + i });
      crew.set(4400 + i, [{ id: 250, name: "Someone", job: "Director" }]);
    }
    const r = invisibleSignature(ctxOf(films, { crew }));
    return r.finding === "none" ? r.emptyCopy : r.headline;
  };

  const dop = build("Director of Photography");
  assert.ok(/shot by The Person/.test(dop), dop);
  assert.ok(!/scored/.test(dop), `a cinematographer did not score anything: ${dop}`);

  const composer = build("Original Music Composer");
  assert.ok(/scored by The Person/.test(composer), composer);
  assert.ok(!/shot by/.test(composer), `a composer did not shoot anything: ${composer}`);

  const editor = build("Editor");
  assert.ok(/cut by The Person/.test(editor), editor);
});
