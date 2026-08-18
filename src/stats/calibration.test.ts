import test from "node:test";
import assert from "node:assert/strict";
import { expectedRating, harshness, MIN_VOTE_COUNT } from "./calibration.ts";
import { rng } from "./primitives.ts";

test("expectedRating is monotone and stays on the Letterboxd scale", () => {
  let prev = -Infinity;
  for (let v = 0; v <= 10; v += 0.1) {
    const r = expectedRating(v);
    assert.ok(r >= prev - 1e-12, `not monotone at vote_average=${v}`);
    assert.ok(r >= 0.5 && r <= 5, `off-scale rating ${r} at vote_average=${v}`);
    prev = r;
  }
  assert.ok(Number.isNaN(expectedRating(NaN)));
});

test("the anchor point matches the population means it was seeded from", () => {
  // TMDB global mean ~6.5 should map near Letterboxd's global mean ~3.25.
  assert.ok(Math.abs(expectedRating(6.5) - 3.25) < 0.01);
});

test("harshness is NOT structurally zero (the bug this file exists to avoid)", () => {
  const rand = rng(5);
  const films = Array.from({ length: 400 }, () => {
    const voteAverage = 5 + rand() * 3.5;
    return { voteAverage, voteCount: 1000, rating: expectedRating(voteAverage) - 0.7 };
  });
  const h = harshness(films);
  // A user rating 0.7 below expectation must read as ~0.7 harsh, not 0.
  assert.ok(Math.abs(h.offset + 0.7) < 0.02, `expected offset ~= -0.7, got ${h.offset}`);

  const generous = harshness(
    films.map((f) => ({ ...f, rating: Math.min(5, f.rating + 1.4) })),
  );
  assert.ok(generous.offset > 0, "a generous rater must read positive");
});

test("good taste is not mistaken for generosity", () => {
  // This user only watches acclaimed films and rates them exactly as expected.
  // Their mean rating is high, but their offset must be ~0.
  const films = Array.from({ length: 200 }, (_, i) => {
    const voteAverage = 8.0 + (i % 10) * 0.05;
    return { voteAverage, voteCount: 5000, rating: expectedRating(voteAverage) };
  });
  const h = harshness(films);
  assert.ok(h.actualMean > 4.0, "sanity: this user's raw mean should be high");
  assert.ok(Math.abs(h.offset) < 0.02, `high mean must not imply generous, got ${h.offset}`);
});

test("noisy crowd averages are excluded rather than trusted", () => {
  const films = [
    { rating: 5, voteAverage: 7.0, voteCount: 5000 },
    { rating: 5, voteAverage: 9.9, voteCount: 3 }, // 3 votes: meaningless
  ];
  const h = harshness(films);
  assert.equal(h.n, 1);
  assert.equal(h.droppedLowVotes, 1);

  assert.equal(harshness([{ rating: 4, voteAverage: 7, voteCount: MIN_VOTE_COUNT - 1 }]).n, 0);
});

test("empty input degrades to NaN, not a crash", () => {
  const h = harshness([]);
  assert.ok(Number.isNaN(h.offset));
  assert.equal(h.n, 0);
});
