import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExport, allFilms, filmKeyFromId, filmKeyFromTitleYear } from "./normalize.ts";

// Real exports use boxd.it short links. Film ids (2-5 chars) come from
// ratings/watched/watchlist; diary carries 6-char DIARY ENTRY ids in a separate
// id space with zero overlap.
const boxd = (id: string) => `https://boxd.it/${id}`;

const DIARY_HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";
const diaryCsv = (...rows: string[]) => [DIARY_HEADER, ...rows].join("\n");
const ratingsCsv = (...rows: string[]) => ["Date,Name,Year,Letterboxd URI,Rating", ...rows].join("\n");
const watchedCsv = (...rows: string[]) => ["Date,Name,Year,Letterboxd URI", ...rows].join("\n");
const watchlistCsv = (...rows: string[]) => ["Date,Name,Year,Letterboxd URI", ...rows].join("\n");

test("diary rows join to film ids by (name, year), not by URI", () => {
  // The diary URI is an ENTRY id and appears nowhere in the film lists.
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Salaar: Part 1 - Ceasefire,2023,${boxd("czvlfp")},4.5,Yes,,2025-07-12`),
    watched: watchedCsv(`2024-03-13,Salaar: Part 1 - Ceasefire,2023,${boxd("nQFa")}`),
  });
  assert.equal(s.diary.length, 1);
  assert.equal(s.diary[0]!.entryId, "czvlfp", "entry id preserved");
  assert.equal(s.diary[0]!.filmId, "nQFa", "joined to the real film id");
  assert.equal(s.diary[0]!.filmKey, filmKeyFromId("nQFa"));
  assert.equal(s.audit.diaryJoinedToFilmId, 1);
  assert.equal(s.audit.diaryUnjoined, 0);
});

test("a diary row with no matching film falls back to a title+year key", () => {
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Some Unlisted Film,2019,${boxd("czvjrt")},3,,,2026-01-10`),
  });
  assert.equal(s.diary[0]!.filmId, null);
  assert.equal(s.diary[0]!.filmKey, filmKeyFromTitleYear("Some Unlisted Film", 2019));
  assert.equal(s.audit.diaryUnjoined, 1);
});

test("dedupe is keyed on (film, watched date), not the unique-per-row entry id", () => {
  // Same film, same watched date, two different entry ids -> one survives.
  const s = normalizeExport({
    diary: diaryCsv(
      `2026-01-11,Dune,2021,${boxd("czvAAA")},4,,,2026-01-10`,
      `2026-01-11,Dune,2021,${boxd("czvBBB")},4,,,2026-01-10`,
    ),
    watched: watchedCsv(`2024-01-01,Dune,2021,${boxd("dNAA")}`),
  });
  assert.equal(s.diary.length, 1);
  assert.equal(s.audit.duplicatesDropped, 1);
});

test("the same film on different watched dates survives as separate viewings", () => {
  const s = normalizeExport({
    diary: diaryCsv(
      `2025-07-13,Salaar,2023,${boxd("czvAAA")},4.5,Yes,,2025-07-12`,
      `2026-03-30,Salaar,2023,${boxd("czvBBB")},4.5,Yes,,2026-03-30`,
      `2026-05-25,Salaar,2023,${boxd("czvCCC")},4.5,Yes,,2026-05-24`,
    ),
    watched: watchedCsv(`2024-01-01,Salaar,2023,${boxd("nQFa")}`),
  });
  assert.equal(s.diary.length, 3);
  assert.equal(s.audit.duplicatesDropped, 0);
  assert.equal(s.audit.diaryDistinctFilms, 1, "three viewings of one film");
});

test("a backfill of 11 is caught by watched-date spread, not by count", () => {
  // The real failure case: 11 entries logged on one day with watched dates
  // spanning a year. A count-only threshold of 20 missed this entirely.
  const rows = [
    "2023-12-21", "2024-01-20", "2024-03-30", "2024-05-23", "2024-06-22",
    "2024-08-02", "2024-08-24", "2024-09-21", "2024-10-11", "2024-11-22", "2024-12-21",
  ].map((watched, i) => `2026-01-11,Salaar,2023,${boxd(`czv${i}`)},4.5,Yes,,${watched}`);

  const s = normalizeExport({ diary: diaryCsv(...rows) });
  assert.equal(s.diary.length, 11, "distinct watched dates, so none are duplicates");
  assert.ok(s.diary.every((e) => e.bulkLogged), "all must be flagged as a bulk import");
  assert.equal(s.audit.cleanDatedCount, 0, "a backfill must not feed temporal stats");
});

test("a genuine multi-film day is NOT flagged as a backfill", () => {
  // Three films watched and logged the same day: a real double/triple feature.
  const rows = ["a", "b", "c"].map((x, i) => `2026-03-30,Film ${x},202${i},${boxd(`czv${x}`)},4,,,2026-03-30`);
  const s = normalizeExport({ diary: diaryCsv(...rows) });
  assert.ok(s.diary.every((e) => !e.bulkLogged), "same-day viewing is not an import");
  assert.equal(s.audit.cleanDatedCount, 3);
});

test("a long lag excludes an entry from clean-dated but keeps it counted", () => {
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Old Film,2005,${boxd("czvXXX")},4,,,2023-12-21`),
  });
  assert.equal(s.diary.length, 1);
  assert.ok(s.diary[0]!.lagDays! > 700);
  assert.equal(s.diary[0]!.cleanDated, false);
});

test("film lists parse from boxd.it ids and share one id space", () => {
  const s = normalizeExport({
    ratings: ratingsCsv(`2024-03-13,Everything Everywhere All at Once,2022,${boxd("jUk4")},4`),
    watched: watchedCsv(`2024-03-13,Everything Everywhere All at Once,2022,${boxd("jUk4")}`),
    watchlist: watchlistCsv(`2023-05-05,Come and See,1985,${boxd("2bxG")}`),
  });
  assert.equal(s.ratings[0]!.filmId, "jUk4");
  assert.equal(s.ratings[0]!.filmKey, s.watched[0]!.filmKey, "same film, same key across files");
  assert.equal(s.watchlist[0]!.filmId, "2bxG");
  assert.equal(s.audit.distinctFilms, 2, "the shared film counts once");
});

test("the watched-to-diary ratio is surfaced, since it decides which stats render", () => {
  const watchedRows = Array.from({ length: 40 }, (_, i) => `2024-01-01,Film ${i},2020,${boxd(`w${i}`)}`);
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Film 0,2020,${boxd("czvZZZ")},4,,,2026-01-10`),
    watched: watchedCsv(...watchedRows),
  });
  assert.equal(s.audit.watchedRows, 40);
  assert.equal(s.audit.diaryEntriesKept, 1);
  assert.equal(s.audit.watchedToDiaryRatio, 40);
});

test("ratings are validated to the half-star scale", () => {
  const s = normalizeExport({
    ratings: ratingsCsv(
      `2024-01-01,Good,2020,${boxd("aa")},4.5`,
      `2024-01-01,Bad,2020,${boxd("bb")},4.3`,
      `2024-01-01,Worse,2020,${boxd("cc")},9`,
      `2024-01-01,Empty,2020,${boxd("dd")},`,
    ),
  });
  assert.equal(s.ratings.length, 1, "only the valid half-star rating survives");
  assert.equal(s.ratings[0]!.rating, 4.5);
});

test("unrated diary entries are kept and counted separately", () => {
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Unrated,2020,${boxd("czvQQQ")},,,,2026-01-10`),
  });
  assert.equal(s.diary.length, 1);
  assert.equal(s.diary[0]!.rating, null);
  assert.equal(s.audit.ratedEntries, 0);
  assert.equal(s.audit.unratedEntries, 1);
});

test("rows with an unusable URI, date or name are counted as unparseable", () => {
  const s = normalizeExport({
    diary: diaryCsv(
      `2026-01-11,No URI,2020,,4,,,2026-01-10`,
      `not-a-date,Bad Date,2020,${boxd("czvRRR")},4,,,2026-01-10`,
      `2026-01-11,,2020,${boxd("czvSSS")},4,,,2026-01-10`,
    ),
  });
  assert.equal(s.diary.length, 0);
  assert.equal(s.audit.unparseableDropped, 3);
});

test("tags and the rewatch flag parse", () => {
  const s = normalizeExport({
    diary: diaryCsv(`2026-01-11,Tagged,2020,${boxd("czvTTT")},4,Yes,"slow, favourite",2026-01-10`),
  });
  assert.deepEqual(s.diary[0]!.tags, ["slow", "favourite"]);
  assert.equal(s.diary[0]!.rewatch, true);
});

test("allFilms unions every list and backfills a missing year", () => {
  const s = normalizeExport({
    ratings: ratingsCsv(`2024-01-01,Heat,,${boxd("hh")},4`),
    watched: watchedCsv(`2024-01-01,Heat,1995,${boxd("hh")}`),
    watchlist: watchlistCsv(`2023-01-01,Stalker,1979,${boxd("ss")}`),
  });
  const films = allFilms(s);
  assert.equal(films.size, 2);
  assert.equal(films.get(filmKeyFromId("hh"))!.year, 1995, "year filled from the list that had it");
});

test("an empty export produces empty output, not a crash", () => {
  const s = normalizeExport({});
  assert.equal(s.diary.length, 0);
  assert.equal(s.audit.distinctFilms, 0);
  assert.equal(s.audit.watchedToDiaryRatio, null);
});
