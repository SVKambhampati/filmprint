import test from "node:test";
import assert from "node:assert/strict";
import {
  slugFromUri,
  normalizeTitle,
  diceSimilarity,
  scoreCandidate,
  chooseMatch,
  ACCEPT_THRESHOLD,
  type Candidate,
} from "./match.ts";

const cand = (p: Partial<Candidate> & { id: number }): Candidate => ({
  title: "",
  original_title: "",
  release_date: "",
  vote_count: 0,
  ...p,
});

test("slugFromUri extracts film slugs and rejects non-film URIs", () => {
  assert.equal(slugFromUri("https://letterboxd.com/film/parasite/"), "parasite");
  assert.equal(slugFromUri("https://boxd.it/hTha"), null, "short links carry no slug");
  // TV entries are not under /film/ and must not silently become films.
  assert.equal(slugFromUri("https://letterboxd.com/tv/severance/"), null);
  assert.equal(slugFromUri(""), null);
});

test("normalizeTitle handles diacritics, articles, punctuation, ampersands", () => {
  assert.equal(normalizeTitle("Amélie"), "amelie");
  assert.equal(normalizeTitle("The Godfather"), "godfather");
  assert.equal(normalizeTitle("WALL·E"), "wall e");
  assert.equal(normalizeTitle("Am I OK?"), "am i ok");
  assert.equal(normalizeTitle("Fast & Furious"), "fast and furious");
  assert.equal(normalizeTitle("Dune 2021"), "dune", "trailing year stripped");
  // Articles only strip at the START.
  assert.equal(normalizeTitle("Take the Money"), "take the money");
});

test("diceSimilarity is bounded and symmetric-ish", () => {
  assert.equal(diceSimilarity("parasite", "parasite"), 1);
  assert.equal(diceSimilarity("a", "b"), 0);
  assert.ok(diceSimilarity("godfather", "the godfather part ii") < 0.8);
});

test("exact title + exact year wins over a same-title remake", () => {
  const candidates = [
    cand({ id: 1, title: "Dune", release_date: "1984-12-14", vote_count: 3000 }),
    cand({ id: 2, title: "Dune", release_date: "2021-09-15", vote_count: 11000 }),
  ];
  assert.equal(chooseMatch("Dune", 2021, candidates).tmdbId, 2);
  assert.equal(chooseMatch("Dune", 1984, candidates).tmdbId, 1);
});

test("foreign films match on original_title as well as title", () => {
  const c = [cand({ id: 496243, title: "Parasite", original_title: "기생충", release_date: "2019-05-30", vote_count: 18000 })];
  assert.equal(chooseMatch("Parasite", 2019, c).tmdbId, 496243);
  assert.equal(chooseMatch("기생충", 2019, c).tmdbId, 496243);
});

test("a one-year release-date discrepancy still matches, flagged as year_slack", () => {
  // TMDB often holds the festival date; Letterboxd often holds the wide release.
  const c = [cand({ id: 7, title: "Drive My Car", release_date: "2021-08-20", vote_count: 900 })];
  const out = chooseMatch("Drive My Car", 2022, c);
  assert.equal(out.tmdbId, 7);
  assert.equal(out.method, "year_slack");
});

test("a wrong-decade candidate is refused rather than guessed", () => {
  const c = [cand({ id: 9, title: "Nosferatu", release_date: "1922-03-04", vote_count: 2000 })];
  const out = chooseMatch("Nosferatu", 2024, c);
  assert.equal(out.tmdbId, null);
  assert.equal(out.method, "unmatched");
  assert.ok(out.confidence < ACCEPT_THRESHOLD);
});

test("empty candidate list is unmatched, not a crash", () => {
  const out = chooseMatch("Some Obscure Short", 1968, []);
  assert.equal(out.tmdbId, null);
  assert.equal(out.runnerUp, null);
});

test("runnerUp is reported so ambiguous matches can be audited", () => {
  const candidates = [
    cand({ id: 1, title: "The Killer", release_date: "2023-10-25", vote_count: 2000 }),
    cand({ id: 2, title: "The Killer", release_date: "2023-11-10", vote_count: 1500 }),
  ];
  const out = chooseMatch("The Killer", 2023, candidates);
  assert.ok(out.runnerUp !== null, "a near-tie must expose its runner-up");
  assert.ok(Math.abs(out.confidence - out.runnerUp!) < 0.05, "this really is a near-tie");
});

test("vote_count only breaks ties, it does not override title/year", () => {
  const candidates = [
    cand({ id: 1, title: "Solaris", release_date: "2002-11-27", vote_count: 90000 }),
    cand({ id: 2, title: "Solaris", release_date: "1972-03-20", vote_count: 1200 }),
  ];
  assert.equal(chooseMatch("Solaris", 1972, candidates).tmdbId, 2, "year must beat popularity");
});

test("scoreCandidate rewards slug agreement slightly", () => {
  const c = cand({ id: 1, title: "Aftersun", release_date: "2022-10-21", vote_count: 800 });
  const withSlug = scoreCandidate("Aftersun", 2022, c, "aftersun");
  const withoutSlug = scoreCandidate("Aftersun", 2022, c, null);
  assert.ok(withSlug >= withoutSlug);
  assert.ok(withSlug <= 1, "score must stay bounded at 1");
});
