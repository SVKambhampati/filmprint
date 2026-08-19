/**
 * Turning a raw Letterboxd export into something a stat can trust.
 *
 * Everything here is driven by facts verified against a real export, not
 * assumed. The ones that matter:
 *
 *  1. URIs are boxd.it SHORT LINKS, not letterboxd.com/film/<slug>/.
 *
 *  2. There are TWO ID SPACES, and confusing them silently breaks every join.
 *     ratings.csv / watched.csv / watchlist.csv carry FILM ids (2-5 chars).
 *     diary.csv carries DIARY ENTRY ids (6 chars) with zero overlap. A diary row
 *     cannot be joined to a film by its URI at all — it joins on (Name, Year).
 *
 *  3. watched.csv is far wider than diary.csv. Users rate and mark watched
 *     without logging a diary entry, so date-based stats have a much smaller
 *     sample than rating-based ones. In the export used to build this, the ratio
 *     was 1868 to 100.
 *
 *  4. ratings.csv holds only the CURRENT film-level rating, overwritten on
 *     re-rate. Per-entry ratings live in diary.csv. Never mix them into one
 *     denominator.
 *
 *  5. Deleted content is segregated into deleted/ and orphaned/ subdirectories
 *     rather than mixed into the root files, so reading only the root is correct.
 *
 *  6. Backfills are small. 11 entries logged on one day, with watched dates
 *     spanning a year, is a backfill — so a bulk detector keyed on count alone
 *     misses it. Spread of watched dates is the reliable signal.
 */
import { parseCsv } from "./csv.ts";
import { letterboxdId, normalizeTitle } from "../tmdb/match.ts";

/**
 * Stable film identity across the export.
 *
 * `boxd:<id>` when we have a real Letterboxd film id (from ratings, watched or
 * watchlist). `ty:<normalized title>:<year>` for diary rows we could not join to
 * one — a fallback, not an equal: two different films sharing a title and year
 * would collide, which is rare enough to accept and honest enough to name.
 */
export type FilmKey = string;

export function filmKeyFromId(id: string): FilmKey {
  return `boxd:${id}`;
}

export function filmKeyFromTitleYear(name: string, year: number | null): FilmKey {
  return `ty:${normalizeTitle(name)}:${year ?? "?"}`;
}

export type DiaryEntry = {
  /** Identifies this LOG ENTRY, not the film. */
  entryId: string;
  filmKey: FilmKey;
  /** The Letterboxd film id, when the (name, year) join succeeded. */
  filmId: string | null;
  name: string;
  year: number | null;
  loggedDate: string;
  watchedDate: string | null;
  rating: number | null;
  rewatch: boolean;
  tags: string[];
  lagDays: number | null;
  bulkLogged: boolean;
  placeholderDate: boolean;
  /** Safe for temporal stats. See GATES.cleanDated before slicing by month. */
  cleanDated: boolean;
};

export type RatingEntry = { filmKey: FilmKey; filmId: string; name: string; year: number | null; rating: number };

/**
 * A written review.
 *
 * reviews.csv carries DIARY ENTRY ids, not film ids — verified against a real
 * export: 72 of 72 matched diary entries, none matched a film id. So reviews join
 * to the diary exactly, and inherit its film key rather than being re-matched.
 */
export type ReviewEntry = {
  entryId: string;
  /** Inherited from the diary entry, or a title+year fallback if that join missed. */
  filmKey: FilmKey;
  name: string;
  year: number | null;
  rating: number | null;
  /** Plain text: HTML stripped, entities decoded, whitespace collapsed. */
  text: string;
  wordCount: number;
};
export type WatchedEntry = { filmKey: FilmKey; filmId: string; name: string; year: number | null; loggedDate: string | null };
export type WatchlistEntry = { filmKey: FilmKey; filmId: string; name: string; year: number | null; addedDate: string };

export type Audit = {
  diaryRowsRead: number;
  diaryEntriesKept: number;
  diaryDistinctFilms: number;
  /** Diary rows joined to a real film id via (name, year). */
  diaryJoinedToFilmId: number;
  diaryUnjoined: number;
  duplicatesDropped: number;
  unparseableDropped: number;
  ratedEntries: number;
  unratedEntries: number;
  cleanDatedCount: number;
  bulkLoggedCount: number;
  ratingsRows: number;
  reviewRows: number;
  watchedRows: number;
  watchlistRows: number;
  distinctFilms: number;
  /** watched.csv size divided by diary size. High means date stats are starved. */
  watchedToDiaryRatio: number | null;
};

export type ExportSummary = {
  diary: DiaryEntry[];
  ratings: RatingEntry[];
  watched: WatchedEntry[];
  watchlist: WatchlistEntry[];
  reviews: ReviewEntry[];
  audit: Audit;
};

const DAY_MS = 86_400_000;

/** Letterboxd ratings are 0.5-5 in half steps. Anything else is corrupt. */
function parseRating(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0.5 || n > 5) return null;
  if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) return null;
  return n;
}

function parseYear(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 1870 && n <= 2100 ? n : null;
}

/** ISO yyyy-mm-dd only. The export carries calendar dates and no timestamps. */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function daysBetween(later: string, earlier: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
}

function parseTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Letterboxd reviews accept HTML, and a raw word count over markup counts tags
 * as words. Strips tags, decodes the handful of entities that actually appear,
 * and collapses whitespace.
 */
export function reviewToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Placeholder watched dates. Backfillers pick the 1st of a month when they do
 * not remember the day. Costs ~3% of genuine entries as false positives, which
 * is the right trade: a fake January spike corrupts every seasonality stat, and
 * these entries still count everywhere except temporal slicing.
 */
function isPlaceholderDate(date: string): boolean {
  return date.split("-")[2] === "01";
}

/** Max plausible gap between watching and logging, in days. */
const MAX_CLEAN_LAG = 90;

/**
 * Bulk-import detection.
 *
 * Two independent signals, because count alone is not enough — a real export had
 * an 11-entry backfill, well under any sane count threshold:
 *
 *   - many entries share one logged date, OR
 *   - entries sharing a logged date have watched dates spanning a long window,
 *     which no single day of viewing can produce.
 */
const BULK_COUNT_THRESHOLD = 8;
const BULK_SPREAD_DAYS = 120;

type FilmLists = { ratings: RatingEntry[]; watched: WatchedEntry[]; watchlist: WatchlistEntry[] };

function parseFilmLists(ratingsText: string, watchedText: string, watchlistText: string): FilmLists {
  const ratings: RatingEntry[] = [];
  for (const r of parseCsv(ratingsText)) {
    const filmId = letterboxdId(r["letterboxd uri"] ?? "");
    const rating = parseRating(r["rating"] ?? "");
    if (!filmId || rating == null) continue;
    ratings.push({
      filmKey: filmKeyFromId(filmId), filmId,
      name: (r["name"] ?? "").trim(), year: parseYear(r["year"] ?? ""), rating,
    });
  }

  const watched: WatchedEntry[] = [];
  for (const r of parseCsv(watchedText)) {
    const filmId = letterboxdId(r["letterboxd uri"] ?? "");
    if (!filmId) continue;
    watched.push({
      filmKey: filmKeyFromId(filmId), filmId,
      name: (r["name"] ?? "").trim(), year: parseYear(r["year"] ?? ""),
      loggedDate: parseDate(r["date"] ?? ""),
    });
  }

  const watchlist: WatchlistEntry[] = [];
  for (const r of parseCsv(watchlistText)) {
    const filmId = letterboxdId(r["letterboxd uri"] ?? "");
    const addedDate = parseDate(r["date"] ?? "");
    if (!filmId || !addedDate) continue;
    watchlist.push({
      filmKey: filmKeyFromId(filmId), filmId,
      name: (r["name"] ?? "").trim(), year: parseYear(r["year"] ?? ""), addedDate,
    });
  }

  return { ratings, watched, watchlist };
}

/**
 * Single entry point. Diary parsing DEPENDS on the film lists, because a diary
 * row has no film id of its own and must be joined on (Name, Year).
 */
export function normalizeExport(files: {
  diary?: string;
  ratings?: string;
  watched?: string;
  watchlist?: string;
  reviews?: string;
}): ExportSummary {
  const { ratings, watched, watchlist } = parseFilmLists(
    files.ratings ?? "", files.watched ?? "", files.watchlist ?? "",
  );

  // (normalized title, year) -> film id, for joining diary rows. Built from the
  // widest lists first so the most complete source wins.
  const titleYearIndex = new Map<string, string>();
  for (const list of [watched, ratings, watchlist]) {
    for (const e of list) {
      const k = filmKeyFromTitleYear(e.name, e.year);
      if (!titleYearIndex.has(k)) titleYearIndex.set(k, e.filmId);
    }
  }

  const rows = parseCsv(files.diary ?? "");
  let unparseableDropped = 0;

  type Draft = Omit<DiaryEntry, "bulkLogged" | "cleanDated" | "placeholderDate">;
  const drafts: Draft[] = [];

  for (const r of rows) {
    const entryId = letterboxdId(r["letterboxd uri"] ?? "");
    const loggedDate = parseDate(r["date"] ?? "");
    const name = (r["name"] ?? "").trim();
    if (!entryId || !loggedDate || name === "") {
      unparseableDropped++;
      continue;
    }
    const year = parseYear(r["year"] ?? "");
    const tyKey = filmKeyFromTitleYear(name, year);
    const filmId = titleYearIndex.get(tyKey) ?? null;
    const watchedDate = parseDate(r["watched date"] ?? "");

    drafts.push({
      entryId,
      filmKey: filmId ? filmKeyFromId(filmId) : tyKey,
      filmId,
      name,
      year,
      loggedDate,
      watchedDate,
      rating: parseRating(r["rating"] ?? ""),
      rewatch: /^(yes|true|1)$/i.test((r["rewatch"] ?? "").trim()),
      tags: parseTags(r["tags"] ?? ""),
      lagDays: watchedDate ? daysBetween(loggedDate, watchedDate) : null,
    });
  }

  // Dedupe on (film, watched date) — NOT on the entry id, which is unique per row
  // by construction and would never collide. The same film on two different days
  // is two genuine viewings and must survive.
  const seen = new Set<string>();
  const deduped: Draft[] = [];
  let duplicatesDropped = 0;
  for (const d of drafts) {
    const key = `${d.filmKey}|${d.watchedDate ?? d.loggedDate}`;
    if (seen.has(key)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(key);
    deduped.push(d);
  }

  // Bulk clusters: count and watched-date spread, per logged date.
  const byLoggedDate = new Map<string, Draft[]>();
  for (const d of deduped) {
    const list = byLoggedDate.get(d.loggedDate);
    if (list) list.push(d);
    else byLoggedDate.set(d.loggedDate, [d]);
  }
  const bulkDates = new Set<string>();
  for (const [date, group] of byLoggedDate) {
    if (group.length >= BULK_COUNT_THRESHOLD) {
      bulkDates.add(date);
      continue;
    }
    const times = group
      .map((g) => (g.watchedDate ? Date.parse(g.watchedDate) : null))
      .filter((t): t is number => t !== null);
    if (times.length >= 2) {
      const spread = (Math.max(...times) - Math.min(...times)) / DAY_MS;
      if (spread >= BULK_SPREAD_DAYS) bulkDates.add(date);
    }
  }

  const diary: DiaryEntry[] = deduped.map((d) => {
    const bulkLogged = bulkDates.has(d.loggedDate);
    const placeholderDate = d.watchedDate ? isPlaceholderDate(d.watchedDate) : false;
    const plausibleLag = d.lagDays != null && d.lagDays >= 0 && d.lagDays <= MAX_CLEAN_LAG;
    return { ...d, bulkLogged, placeholderDate, cleanDated: plausibleLag && !bulkLogged && !placeholderDate };
  });

  // Reviews join to the diary by entry id, so they inherit the diary's film key.
  const diaryByEntry = new Map(diary.map((e) => [e.entryId, e] as const));
  const reviews: ReviewEntry[] = [];
  for (const r of parseCsv(files.reviews ?? "")) {
    const entryId = letterboxdId(r["letterboxd uri"] ?? "");
    const raw = r["review"] ?? "";
    if (!entryId || raw.trim() === "") continue;
    const name = (r["name"] ?? "").trim();
    const year = parseYear(r["year"] ?? "");
    const text = reviewToPlainText(raw);
    reviews.push({
      entryId,
      filmKey: diaryByEntry.get(entryId)?.filmKey ?? filmKeyFromTitleYear(name, year),
      name,
      year,
      rating: parseRating(r["rating"] ?? ""),
      text,
      wordCount: countWords(text),
    });
  }

  const ratedEntries = diary.filter((e) => e.rating != null).length;
  const joined = diary.filter((e) => e.filmId != null).length;
  const distinctFilms = allFilms({ diary, ratings, watched, watchlist }).size;

  return {
    diary,
    ratings,
    watched,
    watchlist,
    reviews,
    audit: {
      diaryRowsRead: rows.length,
      diaryEntriesKept: diary.length,
      diaryDistinctFilms: new Set(diary.map((e) => e.filmKey)).size,
      diaryJoinedToFilmId: joined,
      diaryUnjoined: diary.length - joined,
      duplicatesDropped,
      unparseableDropped,
      ratedEntries,
      unratedEntries: diary.length - ratedEntries,
      cleanDatedCount: diary.filter((e) => e.cleanDated).length,
      bulkLoggedCount: diary.filter((e) => e.bulkLogged).length,
      ratingsRows: ratings.length,
      reviewRows: reviews.length,
      watchedRows: watched.length,
      watchlistRows: watchlist.length,
      distinctFilms,
      watchedToDiaryRatio: diary.length > 0 ? watched.length / diary.length : null,
    },
  };
}

export type FilmRef = { key: FilmKey; name: string; year: number | null };

/** Every distinct film the export references, for the matching pipeline. */
export function allFilms(lists: {
  diary?: readonly { filmKey: FilmKey; name: string; year: number | null }[];
  ratings?: readonly { filmKey: FilmKey; name: string; year: number | null }[];
  watched?: readonly { filmKey: FilmKey; name: string; year: number | null }[];
  watchlist?: readonly { filmKey: FilmKey; name: string; year: number | null }[];
}): Map<FilmKey, FilmRef> {
  const m = new Map<FilmKey, FilmRef>();
  // Widest and most reliable lists first.
  for (const list of [lists.watched, lists.ratings, lists.watchlist, lists.diary]) {
    for (const e of list ?? []) {
      const existing = m.get(e.filmKey);
      if (!existing) m.set(e.filmKey, { key: e.filmKey, name: e.name, year: e.year });
      else if (existing.year == null && e.year != null) existing.year = e.year;
    }
  }
  return m;
}
