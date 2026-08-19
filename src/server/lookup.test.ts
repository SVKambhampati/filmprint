import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store/db.ts";
import { extractFilm } from "../tmdb/schema.ts";
import { BadRequest, MAX_KEYS, etagFor, lookupPayload, parseRequest } from "./lookup.ts";

function storeWith(ids: number[]): Store {
  const s = new Store(":memory:");
  s.transaction(() => {
    for (const id of ids) {
      s.upsertFilm(
        extractFilm({
          id,
          title: `Film ${id}`,
          release_date: "2015-01-01",
          runtime: 110,
          original_language: "en",
          genres: [{ name: "Drama" }],
          production_countries: [{ iso_3166_1: "US" }],
          vote_average: 7,
          vote_count: 4000,
          credits: { cast: [{ id: 1, name: "Actor", order: 0 }], crew: [{ id: 2, name: "Dir", job: "Director" }] },
          keywords: { keywords: [{ name: "grief" }] },
        }),
      );
      s.recordFilm({
        filmKey: `boxd:k${id}`,
        tmdbId: id,
        confidence: 1,
        method: "exact",
        sourceTitle: `Film ${id}`,
        sourceYear: 2015,
      });
    }
  });
  return s;
}

test("only film identifiers are read — anything else in the body is ignored", () => {
  // A buggy or hostile client sending ratings alongside must not have them stored
  // or echoed. The parser reads filmKeys and nothing else, which is where the
  // privacy claim is actually enforced.
  const req = parseRequest({ filmKeys: ["boxd:jUk4"], ratings: [5, 4, 3], userId: "someone" });
  assert.deepEqual(req, { filmKeys: ["boxd:jUk4"] });
  assert.ok(!("ratings" in req));
  assert.ok(!("userId" in req));
});

test("both film key shapes validate", () => {
  const req = parseRequest({ filmKeys: ["boxd:jUk4", "ty:some film:2019", "ty:unknown year:?"] });
  assert.equal(req.filmKeys.length, 3);
});

test("junk keys are skipped rather than failing the whole upload", () => {
  // One malformed row should not cost a user their entire page.
  const req = parseRequest({
    filmKeys: ["boxd:jUk4", "", "../../etc/passwd", 42, null, "DROP TABLE films", "boxd:h4cS"],
  });
  assert.deepEqual(req.filmKeys, ["boxd:jUk4", "boxd:h4cS"]);
});

test("duplicate keys collapse", () => {
  assert.deepEqual(parseRequest({ filmKeys: ["boxd:a", "boxd:a", "boxd:b"] }).filmKeys, ["boxd:a", "boxd:b"]);
});

test("malformed and oversized requests are rejected", () => {
  assert.throws(() => parseRequest(null), BadRequest);
  assert.throws(() => parseRequest({}), BadRequest);
  assert.throws(() => parseRequest({ filmKeys: "boxd:a" }), BadRequest);
  assert.throws(() => parseRequest({ filmKeys: [] }), BadRequest);
  assert.throws(() => parseRequest({ filmKeys: ["nonsense", "also nonsense"] }), BadRequest);
  const huge = Array.from({ length: MAX_KEYS + 1 }, (_, i) => `boxd:k${i}`);
  assert.throws(() => parseRequest({ filmKeys: huge }), BadRequest);
});

test("the payload contains only the films that were asked for", () => {
  const s = storeWith([1, 2, 3]);
  const payload = lookupPayload(s, ["boxd:k1", "boxd:k2"]);
  assert.deepEqual(payload.films.map((f) => f.tmdbId).sort(), [1, 2]);
  assert.equal(Object.keys(payload.genres).length, 2, "child rows are scoped to the requested films too");
  s.close();
});

test("unresolved keys are reported, not silently dropped", () => {
  const s = storeWith([1]);
  const payload = lookupPayload(s, ["boxd:k1", "boxd:missing", "ty:some tv show:2022"]);
  assert.equal(payload.films.length, 1);
  assert.deepEqual(payload.unresolved.sort(), ["boxd:missing", "ty:some tv show:2022"]);
  s.close();
});

test("an all-miss request returns an empty payload rather than throwing", () => {
  const s = storeWith([1]);
  const payload = lookupPayload(s, ["boxd:nope"]);
  assert.deepEqual(payload.films, []);
  assert.equal(payload.unresolved.length, 1);
  s.close();
});

test("etags are order-independent and change with the key set", () => {
  const a = etagFor(["boxd:a", "boxd:b"], "1862");
  assert.equal(a, etagFor(["boxd:b", "boxd:a"], "1862"), "same library, different order, same response");
  assert.notEqual(a, etagFor(["boxd:a", "boxd:c"], "1862"), "a different library must not reuse a cached body");
  assert.notEqual(a, etagFor(["boxd:a", "boxd:b"], "1900"), "a refreshed dataset must invalidate");
  assert.notEqual(a, etagFor(["boxd:a"], "1862"), "a subset must not match");
  assert.match(a, /^W\/"/, "weak etag");
});
