import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "./db.ts";
import { extractFilm } from "../tmdb/schema.ts";

const raw = {
  id: 496243,
  title: "Parasite",
  original_title: "기생충",
  release_date: "2019-05-30",
  runtime: 133,
  original_language: "ko",
  spoken_languages: [{ iso_639_1: "ko" }],
  genres: [{ name: "Thriller" }, { name: "Drama" }],
  production_countries: [{ iso_3166_1: "KR" }, { iso_3166_1: "US" }],
  production_companies: [{ id: 1, name: "Barunson" }],
  vote_average: 8.5,
  vote_count: 18000,
  poster_path: "/x.jpg",
  credits: {
    cast: [{ id: 10, name: "Song Kang-ho", order: 0 }],
    crew: [{ id: 1, name: "Bong Joon-ho", job: "Director" }],
  },
  keywords: { keywords: [{ name: "class differences" }] },
};

const fresh = () => new Store(":memory:");

test("a film round-trips with its child rows", () => {
  const s = fresh();
  s.transaction(() => s.upsertFilm(extractFilm(raw)));
  assert.ok(s.hasFilm(496243));
  const genres = s.db.prepare("SELECT genre FROM film_genres WHERE tmdb_id = ?").all(496243);
  assert.equal(genres.length, 2);
  const weights = s.db.prepare("SELECT weight FROM film_countries WHERE tmdb_id = ?").all(496243) as { weight: number }[];
  assert.equal(weights.length, 2);
  assert.ok(Math.abs(weights.reduce((a, w) => a + w.weight, 0) - 1) < 1e-12);
  s.close();
});

test("re-fetching REMOVES child rows that TMDB volunteers deleted", () => {
  const s = fresh();
  s.transaction(() => s.upsertFilm(extractFilm(raw)));
  // Second fetch: a genre and the keyword are gone upstream.
  s.transaction(() => s.upsertFilm(extractFilm({ ...raw, genres: [{ name: "Drama" }], keywords: { keywords: [] } })));
  const genres = s.db.prepare("SELECT genre FROM film_genres WHERE tmdb_id = ?").all(496243);
  assert.equal(genres.length, 1, "stale genre must be gone, not merged");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM film_keywords").get()!.n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM films").get()!.n, 1, "no duplicate film row");
  s.close();
});

test("film resolutions are cached and overwritable", () => {
  const s = fresh();
  s.recordFilm({ filmKey: "parasite", tmdbId: 496243, confidence: 1, method: "exact", sourceTitle: "Parasite", sourceYear: 2019 });
  assert.equal(s.lookupFilm("parasite")!.tmdbId, 496243);
  assert.equal(s.lookupFilm("nope"), null);

  // A hand-correction must be able to replace a bad automatic match.
  s.recordFilm({ filmKey: "parasite", tmdbId: 999, confidence: 1, method: "manual", sourceTitle: "Parasite", sourceYear: 2019 });
  assert.equal(s.lookupFilm("parasite")!.tmdbId, 999);
  assert.equal(s.lookupFilm("parasite")!.method, "manual");
  s.close();
});

test("a negative resolution is recorded so we don't re-query it forever", () => {
  const s = fresh();
  s.recordFilm({ filmKey: "some-short", tmdbId: null, confidence: 0.4, method: "unmatched", sourceTitle: "Some Short", sourceYear: 1968 });
  const hit = s.lookupFilm("some-short");
  assert.notEqual(hit, null, "the row exists");
  assert.equal(hit!.tmdbId, null, "but resolves to nothing");
  assert.equal(s.stats().unresolved, 1);
  s.close();
});

test("unmatched rows accumulate a seen_count for prioritising manual fixes", () => {
  const s = fresh();
  s.recordUnmatched("obscure", "Obscure", 1970, 0.5);
  s.recordUnmatched("obscure", "Obscure", 1970, 0.7);
  const row = s.db.prepare("SELECT seen_count, best_score FROM unmatched WHERE film_key = ?").get("obscure") as { seen_count: number; best_score: number };
  assert.equal(row.seen_count, 2);
  assert.equal(row.best_score, 0.7, "best score should be the max seen");
  s.close();
});

test("a failed transaction rolls back cleanly", () => {
  const s = fresh();
  assert.throws(() =>
    s.transaction(() => {
      s.upsertFilm(extractFilm(raw));
      throw new Error("boom");
    }),
  );
  assert.equal(s.hasFilm(496243), false, "partial write must not persist");
  // The store must still be usable afterwards.
  s.transaction(() => s.upsertFilm(extractFilm(raw)));
  assert.ok(s.hasFilm(496243));
  s.close();
});
