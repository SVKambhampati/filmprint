import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, type StatContext } from "../context.ts";
import { emptyProfile } from "../profile.ts";
import { normalizeExport, filmKeyFromId } from "../../hygiene/normalize.ts";
import type { JoinedFilm } from "../../store/db.ts";
import { zeitgeistLag, LAG_MIN_FILMS } from "./zeitgeist-lag.ts";
import { ipShare, YEAR_MIN_FILMS } from "./ip-share.ts";

type Spec = { id: string; name?: string; rating?: number; year?: number; release?: string; collectionId?: number | null };

function ctxOf(films: Spec[], diaryRows: string[] = []): StatContext {
  const rated = films.filter((f) => f.rating != null);
  const ratings = ["Date,Name,Year,Letterboxd URI,Rating",
    ...rated.map((f) => `2024-01-01,"${f.name ?? f.id}",${f.year ?? 2015},https://boxd.it/${f.id},${f.rating}`)].join("\n");
  const diary = diaryRows.length
    ? ["Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date", ...diaryRows].join("\n")
    : undefined;
  const summary = normalizeExport({ ratings, diary });
  const joined = new Map<string, JoinedFilm>();
  films.forEach((f, i) => joined.set(filmKeyFromId(f.id), {
    filmKey: filmKeyFromId(f.id), tmdbId: 1000 + i, title: f.name ?? f.id,
    releaseDate: f.release ?? `${f.year ?? 2015}-01-01`, runtime: 110,
    originalLanguage: "en", voteAverage: 7, voteCount: 4000,
    collectionId: f.collectionId ?? null, posterPath: null,
  }));
  return buildContext({ summary, profile: { ...emptyProfile(), nRated: rated.length }, joined });
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A diary entry guaranteed to survive hygiene: unique logged date (so no bulk
 * cluster), watched date never the 1st (so not a placeholder), and a one-day
 * log lag. Returns the row plus the release date implied by `lag`.
 *
 * Fixtures that put many entries on one logged date get flagged as a bulk import
 * — correctly — and then vanish from every temporal stat.
 */
function entry(i: number, name: string, lag: number, year = 2015): { row: string; release: string } {
  let watchedMs = Date.parse("2024-01-03") + i * 3 * DAY;
  while (iso(watchedMs).endsWith("-01")) watchedMs += DAY;
  const watched = iso(watchedMs);
  const logged = iso(watchedMs + DAY);
  // The year MUST match the film spec's year: a diary row joins to a film on
  // (name, year), and a mismatch silently produces a title+year fallback key that
  // resolves to nothing. This cost four failing tests to find.
  return {
    row: `${logged},${name},${year},https://boxd.it/czv${i},4,,,${watched}`,
    release: iso(watchedMs - lag * DAY),
  };
}

// ---- zeitgeist lag -----------------------------------------------------

test("an opening-week viewer is identified", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < 40; i++) {
    const e = entry(i, `F${i}`, i % 5); // 0-4 days after release
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  const r = zeitgeistLag(ctxOf(films, rows));
  assert.ok(r.data.medianDays! <= 14, `median ${r.data.medianDays}`);
  assert.ok(r.data.openingWeekShare > 0.9);
  assert.equal(r.finding, "strong");
  assert.ok(/week they land/i.test(r.title ?? ""), r.title ?? "");
});

test("a catch-up viewer is identified", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < 40; i++) {
    const e = entry(i, `F${i}`, 300 + i); // ~10 months later
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  const r = zeitgeistLag(ctxOf(films, rows));
  assert.ok(r.data.medianDays! >= 180, `median ${r.data.medianDays}`);
  assert.equal(r.finding, "strong");
  assert.ok(/eventually/i.test(r.title ?? ""), r.title ?? "");
});

test("catalogue viewing is excluded rather than counted as a 50-year lag", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < 35; i++) {
    const e = entry(i, `N${i}`, 3);
    films.push({ id: `n${i}`, name: `N${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  // A 1975 film watched now: a fifty-year "lag" that must not enter the median.
  const old = entry(100, "Old", 50 * 365);
  films.push({ id: "n100", name: "Old", rating: 4, release: old.release });
  rows.push(old.row);

  const r = zeitgeistLag(ctxOf(films, rows));
  assert.equal(r.data.n, 35, "the catalogue film is excluded from the sample");
  assert.equal(r.data.catalogueExcluded, 1);
  assert.ok(r.data.medianDays! < 10, `median must not be dragged out: ${r.data.medianDays}`);
});

test("a negative lag from a festival screening is dropped, not clamped", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  // Baseline lag is 60 days — deliberately OUTSIDE the opening week, so that if
  // the negative-lag film were clamped to zero it would be the only opening-week
  // entry and the share would jump off zero.
  for (let i = 0; i < 35; i++) {
    const e = entry(i, `F${i}`, 60);
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  // Watched a month BEFORE TMDB's release date: lag of -30.
  const fest = entry(100, "Fest", -30);
  films.push({ id: "f100", name: "Fest", rating: 5, release: fest.release });
  rows.push(fest.row);

  const r = zeitgeistLag(ctxOf(films, rows));
  assert.equal(r.data.n, 35, "the negative lag is dropped");
  assert.equal(r.data.negativeLagExcluded, 1);
  assert.equal(r.data.openingWeekShare, 0, "clamping to zero would have faked an opening-week viewing");
});

test("too few post-join releases yields no claim", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < LAG_MIN_FILMS - 1; i++) {
    const e = entry(i, `F${i}`, 2);
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  const r = zeitgeistLag(ctxOf(films, rows));
  assert.equal(r.finding, "none");
});

test("the copy always discloses that it covers new releases only", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < 40; i++) {
    const e = entry(i, `F${i}`, 60);
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, release: e.release });
    rows.push(e.row);
  }
  const r = zeitgeistLag(ctxOf(films, rows));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(/new releases/i.test(copy), copy);
  assert.ok(/festival or US date/.test(copy), "must disclose the release-date caveat: " + copy);
});

// ---- ip share ---------------------------------------------------------

test("a rising franchise share is reported as a trend", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  let n = 0;
  const build = (year: number, franchiseCount: number) => {
    for (let i = 0; i < YEAR_MIN_FILMS + 10; i++) {
      const inCollection = i < franchiseCount;
      films.push({
        id: `f${n}`, name: `F${n}`, rating: 4, year: 2020,
        release: "2020-01-01", collectionId: inCollection ? 500 + i : null,
      });
      const day = String((i % 27) + 1).padStart(2, "0");
      rows.push(`${year}-06-${day},F${n},2020,https://boxd.it/czv${n},4,,,${year}-06-${day}`);
      n++;
    }
  };
  build(2018, 5);   // ~10%
  build(2024, 40);  // ~80%

  const r = ipShare(ctxOf(films, rows));
  assert.equal(r.data.years.length, 2);
  assert.ok(r.data.changePoints > 10, `expected a big rise, got ${r.data.changePoints}`);
  assert.equal(r.finding, "strong");
  assert.ok(/more franchised/i.test(r.title ?? ""), r.title ?? "");
  assert.equal(r.tone, "unflattering");
});

test("a single year cannot produce a trend", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  for (let i = 0; i < YEAR_MIN_FILMS + 5; i++) {
    films.push({ id: `f${i}`, name: `F${i}`, rating: 4, year: 2020, release: "2020-01-01", collectionId: 1 });
    const day = String((i % 27) + 1).padStart(2, "0");
    rows.push(`2024-06-${day},F${i},2020,https://boxd.it/czv${i},4,,,2024-06-${day}`);
  }
  const r = ipShare(ctxOf(films, rows));
  assert.equal(r.data.years.length, 1);
  assert.equal(r.finding, "none");
  assert.ok(/patchy franchise tagging/.test(r.emptyCopy), r.emptyCopy);
});

test("ip share always downplays the absolute level", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  let n = 0;
  for (const year of [2018, 2024]) {
    for (let i = 0; i < YEAR_MIN_FILMS + 5; i++) {
      films.push({ id: `f${n}`, name: `F${n}`, rating: 4, year: 2020, release: "2020-01-01", collectionId: i % 2 === 0 ? 7 : null });
      const day = String((i % 27) + 1).padStart(2, "0");
      rows.push(`${year}-06-${day},F${n},2020,https://boxd.it/czv${n},4,,,${year}-06-${day}`);
      n++;
    }
  }
  const r = ipShare(ctxOf(films, rows));
  const copy = r.finding === "none" ? r.emptyCopy : r.headline;
  assert.ok(/level is unreliable|percentages as soft|patchy/.test(copy), copy);
});

test("thin years are excluded from the trend", () => {
  const films: Spec[] = [];
  const rows: string[] = [];
  let n = 0;
  // A full year plus a year with only five films.
  for (let i = 0; i < YEAR_MIN_FILMS + 5; i++) {
    films.push({ id: `a${n}`, name: `A${n}`, rating: 4, year: 2020, release: "2020-01-01", collectionId: null });
    rows.push(`2024-06-${String((i % 27) + 1).padStart(2, "0")},A${n},2020,https://boxd.it/czvA${n},4,,,2024-06-${String((i % 27) + 1).padStart(2, "0")}`);
    n++;
  }
  for (let i = 0; i < 5; i++) {
    films.push({ id: `b${n}`, name: `B${n}`, rating: 4, year: 2020, release: "2020-01-01", collectionId: 9 });
    rows.push(`2019-06-0${i + 1},B${n},2020,https://boxd.it/czvB${n},4,,,2019-06-0${i + 1}`);
    n++;
  }
  const r = ipShare(ctxOf(films, rows));
  assert.deepEqual(r.data.years.map((y) => y.year), [2024], "the 5-film year is excluded");
});

test("both new stats survive an empty library", () => {
  const ctx = ctxOf([]);
  for (const stat of [zeitgeistLag, ipShare]) {
    const r = stat(ctx);
    const copy = r.finding === "none" ? r.emptyCopy : r.headline;
    assert.ok(copy.length > 20, `${stat.name} produced no sentence`);
    assert.ok(!/undefined|NaN|null|Infinity/.test(copy), `${stat.name}: ${copy}`);
  }
});
