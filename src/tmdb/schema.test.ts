import test from "node:test";
import assert from "node:assert/strict";
import { extractFilm, MAX_BILLING_ORDER } from "./schema.ts";

const raw = {
  id: 496243,
  title: "Parasite",
  original_title: "기생충",
  release_date: "2019-05-30",
  runtime: 133,
  original_language: "ko",
  spoken_languages: [{ iso_639_1: "ko" }, { iso_639_1: "en" }],
  genres: [{ name: "Comedy" }, { name: "Thriller" }, { name: "Drama" }],
  production_countries: [{ iso_3166_1: "KR" }, { iso_3166_1: "US" }],
  production_companies: [{ id: 1, name: "Barunson E&A" }],
  belongs_to_collection: null,
  vote_average: 8.5,
  vote_count: 18000,
  poster_path: "/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg",
  credits: {
    cast: Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `Actor ${i}`, order: i })),
    crew: [
      { id: 1, name: "Bong Joon-ho", job: "Director" },
      { id: 1, name: "Bong Joon-ho", job: "Director" }, // duplicate credit
      { id: 2, name: "Hong Kyung-pyo", job: "Director of Photography" },
      { id: 3, name: "Jung Jae-il", job: "Original Music Composer" },
      { id: 4, name: "Someone", job: "Gaffer" }, // must be dropped
    ],
  },
  keywords: { keywords: [{ name: "class differences" }, { name: "seoul" }] },
};

test("country attribution is fractional and sums to 1", () => {
  const f = extractFilm(raw);
  assert.equal(f.countries.length, 2);
  const total = f.countries.reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `weights must sum to 1, got ${total}`);
  assert.equal(f.countries[0]!.weight, 0.5);
});

test("a film with no listed countries does not produce NaN weights", () => {
  const f = extractFilm({ ...raw, production_countries: [] });
  assert.deepEqual(f.countries, []);
});

test("crew is filtered to kept jobs and de-duplicated", () => {
  const f = extractFilm(raw);
  assert.equal(f.crew.length, 3, "Gaffer dropped, duplicate Director collapsed");
  assert.ok(!f.crew.some((c) => c.job === "Gaffer"));
  assert.equal(f.crew.filter((c) => c.job === "Director").length, 1);
});

test("cast is capped at the billing cutoff and sorted", () => {
  const f = extractFilm(raw);
  assert.equal(f.cast.length, MAX_BILLING_ORDER + 1); // orders 0..8
  assert.ok(f.cast.every((c) => c.order <= MAX_BILLING_ORDER));
  assert.deepEqual([...f.cast].sort((a, b) => a.order - b.order), f.cast);
});

test("cut fields never appear on the extracted object", () => {
  const f = extractFilm(raw) as Record<string, unknown>;
  for (const cut of ["budget", "revenue", "popularity", "gender"]) {
    assert.ok(!(cut in f), `${cut} was cut and must not be stored`);
  }
});

test("missing and empty values normalise to null rather than 0 or ''", () => {
  const f = extractFilm({ id: 1 });
  assert.equal(f.releaseDate, null);
  assert.equal(f.runtime, null);
  assert.equal(f.collectionId, null);
  assert.equal(f.posterPath, null);
  // runtime 0 means "unknown", not "zero minutes".
  assert.equal(extractFilm({ id: 1, runtime: 0 }).runtime, null);
  assert.equal(extractFilm({ id: 1, release_date: "" }).releaseDate, null);
});

test("fetchedAt is recorded so vote counts stay reproducible", () => {
  const f = extractFilm(raw, "2026-08-17T00:00:00.000Z");
  assert.equal(f.fetchedAt, "2026-08-17T00:00:00.000Z");
});
