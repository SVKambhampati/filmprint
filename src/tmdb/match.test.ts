import test from "node:test";
import assert from "node:assert/strict";
import {
  letterboxdId,
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

test("letterboxdId reads boxd.it short links, which is what real exports use", () => {
  // Real exports use short links exclusively. An earlier version of this test
  // asserted these return null, which is why the first live run matched nothing.
  assert.equal(letterboxdId("https://boxd.it/jUk4"), "jUk4");
  assert.equal(letterboxdId("https://boxd.it/czvlfp"), "czvlfp");
  // Case is preserved: boxd.it ids are case-sensitive.
  assert.equal(letterboxdId("https://boxd.it/wUow"), "wUow");
  // The long form is still accepted for older exports.
  assert.equal(letterboxdId("https://letterboxd.com/film/parasite/"), "parasite");
  assert.equal(letterboxdId(""), null);
  assert.equal(letterboxdId("not a url"), null);
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

test("a unique exact title survives a festival-vs-release year gap", () => {
  // Am I OK? premiered at Sundance in 2022; TMDB holds the 2024 wide release.
  // Perfect title, no rival candidate -> must match, flagged year_slack.
  const c = [cand({ id: 641934, title: "Am I OK?", release_date: "2024-06-06", vote_count: 357 })];
  const out = chooseMatch("Am I OK?", 2022, c);
  assert.equal(out.tmdbId, 641934);
  assert.equal(out.method, "year_slack");
});

test("but a unique exact title a century away is still refused", () => {
  const c = [cand({ id: 653, title: "Nosferatu", release_date: "1922-03-04", vote_count: 2000 })];
  assert.equal(chooseMatch("Nosferatu", 2024, c).tmdbId, null, "102 years is a different film");
});

test("the year-gap rescue does not fire when a rival exact title exists", () => {
  // Two Dunes: the rescue must stay off and the year must decide.
  const candidates = [
    cand({ id: 841, title: "Dune", release_date: "1984-12-14", vote_count: 3000 }),
    cand({ id: 438631, title: "Dune", release_date: "2021-09-15", vote_count: 11000 }),
  ];
  assert.equal(chooseMatch("Dune", 1984, candidates).tmdbId, 841);
  assert.equal(chooseMatch("Dune", 2021, candidates).tmdbId, 438631);
  // And a year matching NEITHER should not silently take the popular one.
  assert.equal(chooseMatch("Dune", 1965, candidates).tmdbId, null);
});

test("an exact title with no candidate release date is accepted, not rescued", () => {
  // A missing TMDB release_date costs only a mild year penalty, so an exact
  // unique title clears ACCEPT_THRESHOLD on the ordinary path. The rescue's
  // null-year guard is therefore defensive: with an exact title the score only
  // falls below threshold when BOTH years are known and disagree by 2+.
  const c = [cand({ id: 1, title: "Untitled Thing", release_date: "", vote_count: 5 })];
  const out = chooseMatch("Untitled Thing", 2020, c);
  assert.equal(out.tmdbId, 1);
  assert.ok(out.confidence >= ACCEPT_THRESHOLD, `expected acceptance, got ${out.confidence}`);
});

test("a short Letterboxd title matches TMDB's subtitled one", () => {
  // Real misses from a live run: Letterboxd carries the short theatrical title.
  const glass = [cand({ id: 661374, title: "Glass Onion: A Knives Out Mystery", release_date: "2022-11-23", vote_count: 5000 })];
  const out = chooseMatch("Glass Onion", 2022, glass);
  assert.equal(out.tmdbId, 661374);

  const wake = [cand({ id: 1, title: "Wake Up Dead Man: A Knives Out Mystery", release_date: "2025-12-12", vote_count: 100 })];
  assert.equal(chooseMatch("Wake Up Dead Man", 2025, wake).tmdbId, 1);
});

test("an exact title still outranks a subtitled sibling", () => {
  const candidates = [
    cand({ id: 438631, title: "Dune", release_date: "2021-09-15", vote_count: 11000 }),
    cand({ id: 693134, title: "Dune: Part Two", release_date: "2024-02-27", vote_count: 6000 }),
  ];
  assert.equal(chooseMatch("Dune", 2021, candidates).tmdbId, 438631);
  assert.equal(chooseMatch("Dune: Part Two", 2024, candidates).tmdbId, 693134);
});

test("a prefix match with the wrong year is still refused", () => {
  // Only the sequel exists as a candidate, and the year is 3 years off.
  const c = [cand({ id: 693134, title: "Dune: Part Two", release_date: "2024-02-27", vote_count: 6000 })];
  assert.equal(chooseMatch("Dune", 2021, c).tmdbId, null);
});

test("prefix scoring does not fire on short or non-boundary matches", () => {
  // "her" must not prefix-match "hereditary" -- no word boundary, too short.
  const c = [cand({ id: 1, title: "Hereditary", release_date: "2018-06-08", vote_count: 8000 })];
  assert.equal(chooseMatch("Her", 2013, c).tmdbId, null);
});
