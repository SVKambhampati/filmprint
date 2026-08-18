/**
 * The film metadata store.
 *
 * This is the compounding asset: slug -> tmdb_id resolutions and the metadata
 * behind them are shared across every user, so user #1 pays the fuzzy-match cost
 * and user #500 gets an exact hit. It is a build-time artefact, not live
 * infrastructure.
 *
 * It is deliberately NOT shipped to the browser as a static file. TMDB's terms
 * forbid redistributing their data, and a public JSON blob of 50k films is
 * distribution. A thin lookup endpoint reads from here instead.
 */
import { DatabaseSync } from "node:sqlite";

export type SlugResolution = {
  slug: string;
  tmdbId: number | null;
  confidence: number;
  method: string;
  sourceTitle: string;
  sourceYear: number | null;
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS films (
  tmdb_id           INTEGER PRIMARY KEY,
  title             TEXT    NOT NULL,
  original_title    TEXT    NOT NULL,
  release_date      TEXT,
  runtime           INTEGER,
  original_language TEXT    NOT NULL,
  collection_id     INTEGER,
  collection_name   TEXT,
  vote_average      REAL    NOT NULL,
  vote_count        INTEGER NOT NULL,
  poster_path       TEXT,
  -- Snapshot time for vote_average / vote_count. Without this, a stat computed
  -- today cannot be reproduced or explained next month.
  fetched_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS film_genres (
  tmdb_id INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  genre   TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, genre)
);

-- weight is fractional: a 4-country co-production stores 0.25 four times, so
-- derived shares cannot exceed 100%.
CREATE TABLE IF NOT EXISTS film_countries (
  tmdb_id INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  country TEXT    NOT NULL,
  weight  REAL    NOT NULL,
  PRIMARY KEY (tmdb_id, country)
);

CREATE TABLE IF NOT EXISTS film_languages (
  tmdb_id  INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  language TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, language)
);

CREATE TABLE IF NOT EXISTS film_companies (
  tmdb_id    INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, company_id)
);

CREATE TABLE IF NOT EXISTS film_keywords (
  tmdb_id INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  keyword TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, keyword)
);

CREATE TABLE IF NOT EXISTS film_crew (
  tmdb_id   INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  name      TEXT    NOT NULL,
  job       TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, person_id, job)
);

CREATE TABLE IF NOT EXISTS film_cast (
  tmdb_id       INTEGER NOT NULL REFERENCES films(tmdb_id) ON DELETE CASCADE,
  person_id     INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  billing_order INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, person_id)
);

-- The compounding asset. tmdb_id NULL means "we looked and could not resolve it".
CREATE TABLE IF NOT EXISTS slug_map (
  slug         TEXT PRIMARY KEY,
  tmdb_id      INTEGER,
  confidence   REAL    NOT NULL,
  method       TEXT    NOT NULL,
  source_title TEXT    NOT NULL,
  source_year  INTEGER,
  resolved_at  TEXT    NOT NULL
);

-- Every miss, so match quality can be audited and fixed by hand over time.
CREATE TABLE IF NOT EXISTS unmatched (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  year       INTEGER,
  seen_count INTEGER NOT NULL DEFAULT 1,
  best_score REAL,
  last_seen  TEXT NOT NULL,
  note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_crew_person   ON film_crew(person_id);
CREATE INDEX IF NOT EXISTS idx_cast_person   ON film_cast(person_id);
CREATE INDEX IF NOT EXISTS idx_films_collect ON films(collection_id);
CREATE INDEX IF NOT EXISTS idx_slug_tmdb     ON slug_map(tmdb_id);
`;

// Imported lazily to keep this module usable without a TMDB dependency cycle.
type FilmMetadata = import("../tmdb/schema.ts").FilmMetadata;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Wrap a batch of writes in one transaction. Roughly 100x faster than not. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  hasFilm(tmdbId: number): boolean {
    const row = this.db.prepare("SELECT 1 FROM films WHERE tmdb_id = ?").get(tmdbId);
    return row !== undefined;
  }

  lookupSlug(slug: string): SlugResolution | null {
    const row = this.db
      .prepare(
        `SELECT slug, tmdb_id AS tmdbId, confidence, method,
                source_title AS sourceTitle, source_year AS sourceYear
         FROM slug_map WHERE slug = ?`,
      )
      .get(slug) as SlugResolution | undefined;
    return row ?? null;
  }

  recordSlug(r: SlugResolution): void {
    this.db
      .prepare(
        `INSERT INTO slug_map (slug, tmdb_id, confidence, method, source_title, source_year, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           tmdb_id = excluded.tmdb_id,
           confidence = excluded.confidence,
           method = excluded.method,
           resolved_at = excluded.resolved_at`,
      )
      .run(r.slug, r.tmdbId, r.confidence, r.method, r.sourceTitle, r.sourceYear, new Date().toISOString());
  }

  recordUnmatched(slug: string, title: string, year: number | null, bestScore: number): void {
    this.db
      .prepare(
        `INSERT INTO unmatched (slug, title, year, best_score, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           seen_count = seen_count + 1,
           best_score = MAX(COALESCE(unmatched.best_score, 0), excluded.best_score),
           last_seen  = excluded.last_seen`,
      )
      .run(slug, title, year, bestScore, new Date().toISOString());
  }

  upsertFilm(f: FilmMetadata): void {
    this.db
      .prepare(
        `INSERT INTO films (tmdb_id, title, original_title, release_date, runtime,
                            original_language, collection_id, collection_name,
                            vote_average, vote_count, poster_path, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tmdb_id) DO UPDATE SET
           title = excluded.title,
           original_title = excluded.original_title,
           release_date = excluded.release_date,
           runtime = excluded.runtime,
           original_language = excluded.original_language,
           collection_id = excluded.collection_id,
           collection_name = excluded.collection_name,
           vote_average = excluded.vote_average,
           vote_count = excluded.vote_count,
           poster_path = excluded.poster_path,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        f.tmdbId, f.title, f.originalTitle, f.releaseDate, f.runtime,
        f.originalLanguage, f.collectionId, f.collectionName,
        f.voteAverage, f.voteCount, f.posterPath, f.fetchedAt,
      );

    // Child rows are replaced wholesale: TMDB credits and keywords get edited by
    // volunteers, so a re-fetch must be able to remove entries, not just add.
    for (const table of ["film_genres", "film_countries", "film_languages", "film_companies", "film_keywords", "film_crew", "film_cast"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE tmdb_id = ?`).run(f.tmdbId);
    }

    const genre = this.db.prepare("INSERT OR IGNORE INTO film_genres (tmdb_id, genre) VALUES (?, ?)");
    for (const g of f.genres) genre.run(f.tmdbId, g);

    const country = this.db.prepare("INSERT OR IGNORE INTO film_countries (tmdb_id, country, weight) VALUES (?, ?, ?)");
    for (const c of f.countries) country.run(f.tmdbId, c.code, c.weight);

    const lang = this.db.prepare("INSERT OR IGNORE INTO film_languages (tmdb_id, language) VALUES (?, ?)");
    for (const l of f.spokenLanguages) lang.run(f.tmdbId, l);

    const company = this.db.prepare("INSERT OR IGNORE INTO film_companies (tmdb_id, company_id, name) VALUES (?, ?, ?)");
    for (const c of f.companies) company.run(f.tmdbId, c.id, c.name);

    const kw = this.db.prepare("INSERT OR IGNORE INTO film_keywords (tmdb_id, keyword) VALUES (?, ?)");
    for (const k of f.keywords) kw.run(f.tmdbId, k);

    const crew = this.db.prepare("INSERT OR IGNORE INTO film_crew (tmdb_id, person_id, name, job) VALUES (?, ?, ?, ?)");
    for (const c of f.crew) crew.run(f.tmdbId, c.id, c.name, c.job);

    const cast = this.db.prepare("INSERT OR IGNORE INTO film_cast (tmdb_id, person_id, name, billing_order) VALUES (?, ?, ?, ?)");
    for (const c of f.cast) cast.run(f.tmdbId, c.id, c.name, c.order);
  }

  stats(): { films: number; resolved: number; unresolved: number; unmatched: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      films: one("SELECT COUNT(*) AS n FROM films"),
      resolved: one("SELECT COUNT(*) AS n FROM slug_map WHERE tmdb_id IS NOT NULL"),
      unresolved: one("SELECT COUNT(*) AS n FROM slug_map WHERE tmdb_id IS NULL"),
      unmatched: one("SELECT COUNT(*) AS n FROM unmatched"),
    };
  }
}
