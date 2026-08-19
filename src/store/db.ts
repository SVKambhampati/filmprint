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

export type JoinedFilm = {
  filmKey: string;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  runtime: number | null;
  originalLanguage: string;
  voteAverage: number;
  voteCount: number;
  collectionId: number | null;
  posterPath: string | null;
};

export type FilmResolution = {
  filmKey: string;
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
-- Keyed by film_key, which is "boxd:<id>" for a real Letterboxd film id or
-- "ty:<title>:<year>" for a diary row we could not join to one.
CREATE TABLE IF NOT EXISTS film_map (
  film_key     TEXT PRIMARY KEY,
  tmdb_id      INTEGER,
  confidence   REAL    NOT NULL,
  method       TEXT    NOT NULL,
  source_title TEXT    NOT NULL,
  source_year  INTEGER,
  resolved_at  TEXT    NOT NULL
);

-- Every miss, so match quality can be audited and fixed by hand over time.
CREATE TABLE IF NOT EXISTS unmatched (
  film_key   TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  year       INTEGER,
  seen_count INTEGER NOT NULL DEFAULT 1,
  best_score REAL,
  last_seen  TEXT NOT NULL,
  note       TEXT
);

-- Collection part lists, fetched separately from films: a user's own library
-- cannot tell you how many films a franchise actually has.
CREATE TABLE IF NOT EXISTS collections (
  collection_id INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  fetched_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_parts (
  collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  tmdb_id       INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  release_date  TEXT,
  PRIMARY KEY (collection_id, tmdb_id)
);

CREATE INDEX IF NOT EXISTS idx_crew_person   ON film_crew(person_id);
CREATE INDEX IF NOT EXISTS idx_cast_person   ON film_cast(person_id);
CREATE INDEX IF NOT EXISTS idx_films_collect ON films(collection_id);
CREATE INDEX IF NOT EXISTS idx_film_map_tmdb  ON film_map(tmdb_id);
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

  lookupFilm(filmKey: string): FilmResolution | null {
    const row = this.db
      .prepare(
        `SELECT film_key AS filmKey, tmdb_id AS tmdbId, confidence, method,
                source_title AS sourceTitle, source_year AS sourceYear
         FROM film_map WHERE film_key = ?`,
      )
      .get(filmKey) as FilmResolution | undefined;
    return row ?? null;
  }

  recordFilm(r: FilmResolution): void {
    this.db
      .prepare(
        `INSERT INTO film_map (film_key, tmdb_id, confidence, method, source_title, source_year, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(film_key) DO UPDATE SET
           tmdb_id = excluded.tmdb_id,
           confidence = excluded.confidence,
           method = excluded.method,
           resolved_at = excluded.resolved_at`,
      )
      .run(r.filmKey, r.tmdbId, r.confidence, r.method, r.sourceTitle, r.sourceYear, new Date().toISOString());
  }

  recordUnmatched(filmKey: string, title: string, year: number | null, bestScore: number): void {
    this.db
      .prepare(
        `INSERT INTO unmatched (film_key, title, year, best_score, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(film_key) DO UPDATE SET
           seen_count = seen_count + 1,
           best_score = MAX(COALESCE(unmatched.best_score, 0), excluded.best_score),
           last_seen  = excluded.last_seen`,
      )
      .run(filmKey, title, year, bestScore, new Date().toISOString());
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

  /**
   * Join the user's film keys to the metadata the stats need, in one query.
   *
   * Keys that never resolved are simply absent from the result — that absence is
   * the TV bucket, and callers should report it rather than treat it as zero.
   */
  joinedFilms(filmKeys: readonly string[]): Map<string, JoinedFilm> {
    const out = new Map<string, JoinedFilm>();
    if (filmKeys.length === 0) return out;

    // Chunked to stay well under SQLite's parameter limit on large libraries.
    const CHUNK = 500;
    for (let i = 0; i < filmKeys.length; i += CHUNK) {
      const chunk = filmKeys.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT m.film_key AS filmKey, f.tmdb_id AS tmdbId, f.title, f.release_date AS releaseDate,
                  f.runtime, f.original_language AS originalLanguage, f.vote_average AS voteAverage,
                  f.vote_count AS voteCount, f.collection_id AS collectionId, f.poster_path AS posterPath
           FROM film_map m
           JOIN films f ON f.tmdb_id = m.tmdb_id
           WHERE m.film_key IN (${placeholders})`,
        )
        .all(...chunk) as JoinedFilm[];
      for (const r of rows) out.set(r.filmKey, r);
    }
    return out;
  }

  /** Genres for a set of films. Multi-label: a film appears under several. */
  genresFor(tmdbIds: readonly number[]): Map<number, string[]> {
    return this.#childRows(tmdbIds, "SELECT tmdb_id, genre FROM film_genres WHERE tmdb_id IN", (r) => r.genre as string);
  }

  /**
   * Production countries with their FRACTIONAL weights.
   *
   * A four-country co-production returns 0.25 four times. Summing weights rather
   * than counting rows is what keeps derived shares from exceeding 100%.
   */
  countriesFor(tmdbIds: readonly number[]): Map<number, { code: string; weight: number }[]> {
    const out = new Map<number, { code: string; weight: number }[]>();
    this.#eachChunk(tmdbIds, (chunk, placeholders) => {
      const rows = this.db
        .prepare(`SELECT tmdb_id, country, weight FROM film_countries WHERE tmdb_id IN (${placeholders})`)
        .all(...chunk) as { tmdb_id: number; country: string; weight: number }[];
      for (const r of rows) {
        const list = out.get(r.tmdb_id) ?? [];
        list.push({ code: r.country, weight: r.weight });
        out.set(r.tmdb_id, list);
      }
    });
    return out;
  }

  /** Top-billed cast (order <= 8) for a set of films. */
  castFor(tmdbIds: readonly number[]): Map<number, { id: number; name: string; order: number }[]> {
    const out = new Map<number, { id: number; name: string; order: number }[]>();
    this.#eachChunk(tmdbIds, (chunk, placeholders) => {
      const rows = this.db
        .prepare(`SELECT tmdb_id, person_id, name, billing_order FROM film_cast WHERE tmdb_id IN (${placeholders})`)
        .all(...chunk) as { tmdb_id: number; person_id: number; name: string; billing_order: number }[];
      for (const r of rows) {
        const list = out.get(r.tmdb_id) ?? [];
        list.push({ id: r.person_id, name: r.name, order: r.billing_order });
        out.set(r.tmdb_id, list);
      }
    });
    return out;
  }

  hasCollection(collectionId: number): boolean {
    return this.db.prepare("SELECT 1 FROM collections WHERE collection_id = ?").get(collectionId) !== undefined;
  }

  upsertCollection(c: { id: number; name: string; parts: { id: number; title: string; releaseDate: string | null }[] }): void {
    this.db
      .prepare(
        `INSERT INTO collections (collection_id, name, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(collection_id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at`,
      )
      .run(c.id, c.name, new Date().toISOString());

    // Replaced wholesale: TMDB collections gain and lose entries over time.
    this.db.prepare("DELETE FROM collection_parts WHERE collection_id = ?").run(c.id);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO collection_parts (collection_id, tmdb_id, title, release_date) VALUES (?, ?, ?, ?)",
    );
    for (const p of c.parts) insert.run(c.id, p.id, p.title, p.releaseDate);
  }

  /** Part lists for a set of collections. */
  collectionPartsFor(collectionIds: readonly number[]): Map<number, { tmdbId: number; title: string; releaseDate: string | null }[]> {
    const out = new Map<number, { tmdbId: number; title: string; releaseDate: string | null }[]>();
    this.#eachChunk(collectionIds, (chunk, placeholders) => {
      const rows = this.db
        .prepare(
          `SELECT collection_id, tmdb_id, title, release_date FROM collection_parts
           WHERE collection_id IN (${placeholders})`,
        )
        .all(...chunk) as { collection_id: number; tmdb_id: number; title: string; release_date: string | null }[];
      for (const r of rows) {
        const list = out.get(r.collection_id) ?? [];
        list.push({ tmdbId: r.tmdb_id, title: r.title, releaseDate: r.release_date });
        out.set(r.collection_id, list);
      }
    });
    return out;
  }

  collectionNames(collectionIds: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    this.#eachChunk(collectionIds, (chunk, placeholders) => {
      const rows = this.db
        .prepare(`SELECT collection_id, name FROM collections WHERE collection_id IN (${placeholders})`)
        .all(...chunk) as { collection_id: number; name: string }[];
      for (const r of rows) out.set(r.collection_id, r.name);
    });
    return out;
  }

  /** TMDB keywords for a set of films. */
  keywordsFor(tmdbIds: readonly number[]): Map<number, string[]> {
    return this.#childRows(tmdbIds, "SELECT tmdb_id, keyword FROM film_keywords WHERE tmdb_id IN", (r) => r.keyword as string);
  }

  /** Kept crew (director, DoP, composer, editor) for a set of films. */
  crewFor(tmdbIds: readonly number[]): Map<number, { id: number; name: string; job: string }[]> {
    const out = new Map<number, { id: number; name: string; job: string }[]>();
    this.#eachChunk(tmdbIds, (chunk, placeholders) => {
      const rows = this.db
        .prepare(`SELECT tmdb_id, person_id, name, job FROM film_crew WHERE tmdb_id IN (${placeholders})`)
        .all(...chunk) as { tmdb_id: number; person_id: number; name: string; job: string }[];
      for (const r of rows) {
        const list = out.get(r.tmdb_id) ?? [];
        list.push({ id: r.person_id, name: r.name, job: r.job });
        out.set(r.tmdb_id, list);
      }
    });
    return out;
  }

  #childRows<T>(tmdbIds: readonly number[], sqlPrefix: string, pick: (r: Record<string, unknown>) => T): Map<number, T[]> {
    const out = new Map<number, T[]>();
    this.#eachChunk(tmdbIds, (chunk, placeholders) => {
      const rows = this.db.prepare(`${sqlPrefix} (${placeholders})`).all(...chunk) as Record<string, unknown>[];
      for (const r of rows) {
        const id = r.tmdb_id as number;
        const list = out.get(id) ?? [];
        list.push(pick(r));
        out.set(id, list);
      }
    });
    return out;
  }

  #eachChunk(ids: readonly number[], fn: (chunk: number[], placeholders: string) => void): void {
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      fn(chunk, chunk.map(() => "?").join(","));
    }
  }

  stats(): { films: number; resolved: number; unresolved: number; unmatched: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      films: one("SELECT COUNT(*) AS n FROM films"),
      resolved: one("SELECT COUNT(*) AS n FROM film_map WHERE tmdb_id IS NOT NULL"),
      unresolved: one("SELECT COUNT(*) AS n FROM film_map WHERE tmdb_id IS NULL"),
      unmatched: one("SELECT COUNT(*) AS n FROM unmatched"),
    };
  }
}
