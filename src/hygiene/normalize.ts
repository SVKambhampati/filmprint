/**
 * Turning a raw Letterboxd export into something a stat can trust.
 *
 * Four facts about the export drive everything here:
 *
 *  1. It contains the ENTIRE account, including deleted content and reviews for
 *     films that no longer exist.
 *  2. Letterboxd logs TV now. Those entries will never join to a TMDB movie, and
 *     dropping them silently makes every count quietly wrong.
 *  3. ratings.csv holds only the CURRENT film-level rating, overwritten on
 *     re-rate. Per-entry ratings live in diary.csv. Mixing the two into one
 *     denominator is a category error.
 *  4. Users who joined and backfilled years of history have a huge cluster of
 *     entries logged on one day, with placeholder watched dates. Any temporal
 *     stat computed over those is measuring the import, not the person.
 */
import { parseCsv } from "./csv.ts";
import { slugFromUri } from "../tmdb/match.ts";

export type DiaryEntry = {
  slug: string;
  name: string;
  year: number | null;
  /** Date the entry was created in Letterboxd. */
  loggedDate: string;
  /** Date the user says they watched it. */
  watchedDate: string | null;
  /** 0.5-5 in half steps, or null when logged without a rating. */
  rating: number | null;
  rewatch: boolean;
  tags: string[];
  /** loggedDate - watchedDate, in days. Null when either date is missing. */
  lagDays: number | null;
  /** True when this entry is part of a same-day bulk import cluster. */
  bulkLogged: boolean;
  /** True when the watched date looks like a placeholder (Jan 1, or the 1st). */
  placeholderDate: boolean;
  /**
   * Safe for temporal stats: plausible lag, not a bulk import, not a placeholder
   * date. See GATES.cleanDated before slicing by month or year.
   */
  cleanDated: boolean;
};

export type RatingEntry = { slug: string; name: string; year: number | null; rating: number };

export type WatchlistEntry = { slug: string; name: string; year: number | null; addedDate: string };

export type ExportSummary = {
  diary: DiaryEntry[];
  ratings: RatingEntry[];
  watchlist: WatchlistEntry[];
  /** Counts the UI must surface so users can reconcile our numbers with theirs. */
  audit: {
    diaryRowsRead: number;
    duplicatesDropped: number;
    nonFilmDropped: number;
    unparseableDropped: number;
    ratedCount: number;
    unratedCount: number;
    cleanDatedCount: number;
    bulkLoggedCount: number;
  };
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
  // Cinema starts in the 1880s; allow a little slack for announced films.
  return Number.isFinite(n) && n >= 1870 && n <= 2100 ? n : null;
}

/** ISO yyyy-mm-dd only. The export has no timestamps, so there is no time here. */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function daysBetween(later: string, earlier: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Bulk-import detection.
 *
 * A single logged date carrying an implausible number of entries is an import,
 * not a day of watching. We use entry count here rather than total runtime
 * because runtime requires TMDB metadata that hygiene runs before.
 */
const BULK_SAME_DAY_THRESHOLD = 20;

/** Max plausible gap between watching and logging, in days. */
const MAX_CLEAN_LAG = 90;

/**
 * Placeholder watched dates.
 *
 * Someone backfilling years of history rarely remembers exact dates, so they
 * pick the 1st of a month or Jan 1 of a year. Treating any 1st-of-month as a
 * placeholder costs us roughly 3% of genuinely-dated entries as false
 * positives, which is the right trade: a fake January spike would corrupt every
 * seasonality stat, and those entries are still counted everywhere except
 * temporal slicing.
 */
function isPlaceholderDate(date: string): boolean {
  return date.split("-")[2] === "01";
}

export function normalizeDiary(text: string): { entries: DiaryEntry[]; audit: ExportSummary["audit"] } {
  const rows = parseCsv(text);
  let nonFilmDropped = 0;
  let unparseableDropped = 0;

  type Draft = Omit<DiaryEntry, "bulkLogged" | "cleanDated" | "placeholderDate">;
  const drafts: Draft[] = [];

  for (const r of rows) {
    const uri = r["letterboxd uri"] ?? "";
    const slug = slugFromUri(uri);
    if (!slug) {
      // Not under /film/ — a TV series, an episode, or a malformed row. Counted,
      // not silently discarded.
      nonFilmDropped++;
      continue;
    }
    const loggedDate = parseDate(r["date"] ?? "");
    if (!loggedDate) {
      unparseableDropped++;
      continue;
    }
    const watchedDate = parseDate(r["watched date"] ?? "");
    drafts.push({
      slug,
      name: (r["name"] ?? "").trim(),
      year: parseYear(r["year"] ?? ""),
      loggedDate,
      watchedDate,
      rating: parseRating(r["rating"] ?? ""),
      rewatch: /^(yes|true|1)$/i.test((r["rewatch"] ?? "").trim()),
      tags: parseTags(r["tags"] ?? ""),
      lagDays: watchedDate ? daysBetween(loggedDate, watchedDate) : null,
    });
  }

  // Dedupe on (slug, watchedDate). The export includes deleted content, and the
  // same film watched twice on the same day is far more likely a duplicate than
  // two genuine viewings.
  const seen = new Set<string>();
  const deduped: Draft[] = [];
  let duplicatesDropped = 0;
  for (const d of drafts) {
    const key = `${d.slug}|${d.watchedDate ?? d.loggedDate}`;
    if (seen.has(key)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(key);
    deduped.push(d);
  }

  // Bulk clusters, by logged date.
  const perLoggedDate = new Map<string, number>();
  for (const d of deduped) perLoggedDate.set(d.loggedDate, (perLoggedDate.get(d.loggedDate) ?? 0) + 1);

  const entries: DiaryEntry[] = deduped.map((d) => {
    const bulkLogged = (perLoggedDate.get(d.loggedDate) ?? 0) >= BULK_SAME_DAY_THRESHOLD;
    const placeholderDate = d.watchedDate ? isPlaceholderDate(d.watchedDate) : false;
    const plausibleLag = d.lagDays != null && d.lagDays >= 0 && d.lagDays <= MAX_CLEAN_LAG;
    return {
      ...d,
      bulkLogged,
      placeholderDate,
      cleanDated: plausibleLag && !bulkLogged && !placeholderDate,
    };
  });

  const ratedCount = entries.filter((e) => e.rating != null).length;
  return {
    entries,
    audit: {
      diaryRowsRead: rows.length,
      duplicatesDropped,
      nonFilmDropped,
      unparseableDropped,
      ratedCount,
      unratedCount: entries.length - ratedCount,
      cleanDatedCount: entries.filter((e) => e.cleanDated).length,
      bulkLoggedCount: entries.filter((e) => e.bulkLogged).length,
    },
  };
}

export function normalizeRatings(text: string): RatingEntry[] {
  const out: RatingEntry[] = [];
  for (const r of parseCsv(text)) {
    const slug = slugFromUri(r["letterboxd uri"] ?? "");
    const rating = parseRating(r["rating"] ?? "");
    if (!slug || rating == null) continue;
    out.push({ slug, name: (r["name"] ?? "").trim(), year: parseYear(r["year"] ?? ""), rating });
  }
  return out;
}

export function normalizeWatchlist(text: string): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const r of parseCsv(text)) {
    const slug = slugFromUri(r["letterboxd uri"] ?? "");
    const addedDate = parseDate(r["date"] ?? "");
    if (!slug || !addedDate) continue;
    out.push({ slug, name: (r["name"] ?? "").trim(), year: parseYear(r["year"] ?? ""), addedDate });
  }
  return out;
}

/** Every distinct film slug the export references, for the matching pipeline. */
export function allSlugs(s: Pick<ExportSummary, "diary" | "ratings" | "watchlist">): Map<string, { name: string; year: number | null }> {
  const m = new Map<string, { name: string; year: number | null }>();
  for (const list of [s.diary, s.ratings, s.watchlist]) {
    for (const e of list) if (!m.has(e.slug)) m.set(e.slug, { name: e.name, year: e.year });
  }
  return m;
}
