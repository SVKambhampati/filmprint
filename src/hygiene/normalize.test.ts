import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiary, normalizeRatings, normalizeWatchlist, allSlugs } from "./normalize.ts";

const HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";
const film = (slug: string) => `https://letterboxd.com/film/${slug}/`;

const diaryCsv = (...rows: string[]) => [HEADER, ...rows].join("\n");

test("a normal diary row parses fully", () => {
  const { entries } = normalizeDiary(
    diaryCsv(`2024-03-12,Aftersun,2022,${film("aftersun")},4.5,No,"slow, rewatch-later",2024-03-10`),
  );
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.equal(e.slug, "aftersun");
  assert.equal(e.rating, 4.5);
  assert.equal(e.rewatch, false);
  assert.deepEqual(e.tags, ["slow", "rewatch-later"]);
  assert.equal(e.lagDays, 2);
  assert.equal(e.cleanDated, true);
});

test("TV entries are dropped and counted, never silently lost", () => {
  const { entries, audit } = normalizeDiary(
    diaryCsv(
      `2024-03-12,Aftersun,2022,${film("aftersun")},4.5,No,,2024-03-10`,
      `2024-03-13,Severance,2022,https://letterboxd.com/tv/severance/,5,No,,2024-03-11`,
    ),
  );
  assert.equal(entries.length, 1);
  assert.equal(audit.nonFilmDropped, 1);
});

test("duplicates on (slug, watched date) are dropped", () => {
  const { entries, audit } = normalizeDiary(
    diaryCsv(
      `2024-03-12,Dune,2021,${film("dune-2021")},4,No,,2024-03-10`,
      `2024-03-12,Dune,2021,${film("dune-2021")},4,No,,2024-03-10`,
    ),
  );
  assert.equal(entries.length, 1);
  assert.equal(audit.duplicatesDropped, 1);
});

test("the same film on two different days is kept as two viewings", () => {
  const { entries } = normalizeDiary(
    diaryCsv(
      `2024-03-12,Dune,2021,${film("dune-2021")},4,No,,2024-03-10`,
      `2024-06-12,Dune,2021,${film("dune-2021")},4.5,Yes,,2024-06-10`,
    ),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.rewatch, true);
});

test("unrated logs are kept but excluded from the rated count", () => {
  const { entries, audit } = normalizeDiary(
    diaryCsv(`2024-03-12,Aftersun,2022,${film("aftersun")},,No,,2024-03-10`),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.rating, null);
  assert.equal(audit.ratedCount, 0);
  assert.equal(audit.unratedCount, 1);
});

test("a bulk import cluster is flagged and excluded from clean-dated", () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    `2019-03-04,Film ${i},2010,${film(`film-${i}`)},4,No,,2019-03-0${(i % 8) + 1}`,
  );
  const { entries, audit } = normalizeDiary(diaryCsv(...rows));
  assert.equal(entries.length, 25);
  assert.ok(entries.every((e) => e.bulkLogged), "all 25 share one logged date");
  assert.equal(audit.cleanDatedCount, 0, "bulk entries must not feed temporal stats");
  assert.equal(audit.bulkLoggedCount, 25);
});

test("placeholder watched dates are excluded from clean-dated", () => {
  const { entries } = normalizeDiary(
    diaryCsv(`2024-03-12,Aftersun,2022,${film("aftersun")},4.5,No,,2024-03-01`),
  );
  assert.equal(entries[0]!.placeholderDate, true);
  assert.equal(entries[0]!.cleanDated, false);
});

test("implausible lags are excluded from clean-dated but kept as entries", () => {
  const { entries } = normalizeDiary(
    diaryCsv(
      // Logged three years after watching: a backfill.
      `2024-03-12,Old Film,2005,${film("old-film")},4,No,,2021-03-12`,
      // Logged BEFORE watching: a typo.
      `2024-03-12,Typo Film,2020,${film("typo-film")},4,No,,2024-04-20`,
    ),
  );
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => !e.cleanDated));
  assert.ok(entries[1]!.lagDays! < 0, "negative lag detected");
});

test("corrupt ratings and years are rejected without dropping the entry", () => {
  const { entries } = normalizeDiary(
    diaryCsv(
      `2024-03-12,Weird,abcd,${film("weird")},4.3,No,,2024-03-10`, // 4.3 is not a half step
      `2024-03-13,Weird2,2020,${film("weird2")},9,No,,2024-03-11`, // out of range
    ),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.rating, null);
  assert.equal(entries[0]!.year, null);
  assert.equal(entries[1]!.rating, null);
});

test("ratings.csv and watchlist.csv parse independently of the diary", () => {
  const ratings = normalizeRatings(
    [`Date,Name,Year,Letterboxd URI,Rating`, `2024-01-01,Dune,2021,${film("dune-2021")},4.5`].join("\n"),
  );
  assert.deepEqual(ratings, [{ slug: "dune-2021", name: "Dune", year: 2021, rating: 4.5 }]);

  const wl = normalizeWatchlist(
    [`Date,Name,Year,Letterboxd URI`, `2023-05-05,Stalker,1979,${film("stalker")}`].join("\n"),
  );
  assert.equal(wl[0]!.addedDate, "2023-05-05");
});

test("allSlugs unions diary, ratings and watchlist without duplicates", () => {
  const { entries } = normalizeDiary(diaryCsv(`2024-03-12,Dune,2021,${film("dune-2021")},4,No,,2024-03-10`));
  const slugs = allSlugs({
    diary: entries,
    ratings: [{ slug: "dune-2021", name: "Dune", year: 2021, rating: 4 }],
    watchlist: [{ slug: "stalker", name: "Stalker", year: 1979, addedDate: "2023-05-05" }],
  });
  assert.equal(slugs.size, 2);
  assert.ok(slugs.has("dune-2021") && slugs.has("stalker"));
});

test("an empty or header-only export is handled", () => {
  assert.equal(normalizeDiary("").entries.length, 0);
  assert.equal(normalizeDiary(HEADER).entries.length, 0);
});
