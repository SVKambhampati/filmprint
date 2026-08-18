import test from "node:test";
import assert from "node:assert/strict";
import {
  shrink,
  quantile,
  median,
  entropyBits,
  plugInEntropyBits,
  effectiveCategories,
  kendallTauB,
  bootstrapCI,
  permutationP,
  rng,
} from "./primitives.ts";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);

test("shrink pulls small groups toward the prior", () => {
  // Two films at 5.0 with a user mean of 3.5 must not read as a 5.0 group.
  const adjusted = shrink(5.0, 2, 3.5, 8);
  close(adjusted, (2 * 5.0 + 8 * 3.5) / 10);
  assert.ok(adjusted < 4.0, "two great films should not produce a 4+ group mean");

  // A large group should barely move.
  assert.ok(shrink(5.0, 500, 3.5, 8) > 4.9);

  // Empty group falls back to the prior rather than NaN.
  close(shrink(NaN, 0, 3.5, 8), 3.5);
});

test("quantile interpolates and median matches", () => {
  close(quantile([1, 2, 3, 4], 0.5), 2.5);
  close(median([1, 2, 3, 4]), 2.5);
  close(median([1, 2, 3]), 2);
  close(quantile([1, 2, 3, 4], 0), 1);
  close(quantile([1, 2, 3, 4], 1), 4);
});

test("entropy: uniform over 2 bins is 1 bit, degenerate is 0", () => {
  // Large n so the Miller-Madow correction is negligible.
  close(plugInEntropyBits([5000, 5000]), 1);
  close(plugInEntropyBits([10000]), 0);
  close(plugInEntropyBits([2500, 2500, 2500, 2500]), 2);
});

test("Miller-Madow reduces entropy bias in expectation at small n", () => {
  // The plug-in estimator's downward bias is a property of the estimator
  // averaged over random samples, NOT of any single sample: a perfectly uniform
  // sample like [4,4,4,...] has zero bias, and correcting it only overshoots.
  // So we draw many small samples from a known uniform distribution and compare
  // the AVERAGE error of each estimator against the truth.
  const bins = 10;
  const n = 40;
  const truth = Math.log2(bins);
  const rand = rng(1234);

  let plugErr = 0;
  let corrErr = 0;
  const trials = 800;
  for (let t = 0; t < trials; t++) {
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < n; i++) counts[Math.floor(rand() * bins)]++;
    plugErr += plugInEntropyBits(counts) - truth;
    corrErr += entropyBits(counts) - truth;
  }
  plugErr /= trials;
  corrErr /= trials;

  assert.ok(plugErr < 0, `plug-in should be biased downward, got ${plugErr}`);
  assert.ok(
    Math.abs(corrErr) < Math.abs(plugErr),
    `correction should reduce mean error: |${corrErr}| should be < |${plugErr}|`,
  );

  // The correction must vanish as n grows.
  const big = new Array(bins).fill(4000);
  assert.ok(entropyBits(big) - plugInEntropyBits(big) < 0.001);

  // And it must always be non-negative (it only ever raises the estimate).
  assert.ok(entropyBits([4, 4, 4, 4]) >= plugInEntropyBits([4, 4, 4, 4]));
});

test("effectiveCategories behaves like a count of meaningfully-used buckets", () => {
  close(effectiveCategories([5000, 5000]), 2, 1e-3);
  const lopsided = effectiveCategories([9800, 100, 100]);
  assert.ok(lopsided > 1 && lopsided < 1.5, `expected ~1.2, got ${lopsided}`);
});

test("kendallTauB: perfect, inverse, and independent cases", () => {
  close(kendallTauB([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1);
  close(kendallTauB([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  // Classic tie-heavy case with zero association.
  close(kendallTauB([1, 1, 2, 2], [1, 2, 1, 2]), 0);
  // Monotone but not linear -> still 1 (this is why we use rank correlation).
  close(kendallTauB([1, 2, 3, 4], [1, 10, 100, 1000]), 1);
});

test("kendallTauB handles the massive-ties case a rating scale produces", () => {
  // 10 discrete rating values vs a continuous crowd score, same ordering.
  const user = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
  const crowd = [5.0, 5.1, 5.2, 6.0, 6.1, 6.2, 7.0, 7.1, 7.2, 8.0, 8.1, 8.2];
  const tau = kendallTauB(user, crowd);
  // Not 1.0, because the user's ties are untied by the crowd, but strongly
  // positive. The point is that tau-b does not collapse to a tiny number.
  assert.ok(tau > 0.85, `expected strong positive tau-b, got ${tau}`);

  // A constant variable has undefined rank correlation.
  assert.ok(Number.isNaN(kendallTauB([3, 3, 3, 3], [1, 2, 3, 4])));
});

test("kendallTauB agrees with the naive O(n^2) definition on random data", () => {
  const rand = rng(42);
  const n = 300;
  const xs = Array.from({ length: n }, () => Math.floor(rand() * 10) / 2);
  const ys = Array.from({ length: n }, () => Math.round(rand() * 100) / 10);

  let con = 0;
  let dis = 0;
  let xt = 0;
  let yt = 0;
  let bt = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(xs[i]! - xs[j]!);
      const dy = Math.sign(ys[i]! - ys[j]!);
      if (dx === 0 && dy === 0) bt++;
      else if (dx === 0) xt++;
      else if (dy === 0) yt++;
      else if (dx === dy) con++;
      else dis++;
    }
  }
  const n0 = (n * (n - 1)) / 2;
  const naive = (con - dis) / Math.sqrt((n0 - (xt + bt)) * (n0 - (yt + bt)));
  close(kendallTauB(xs, ys), naive, 1e-12);
});

test("bootstrapCI brackets the point estimate and is deterministic", () => {
  const rand = rng(7);
  const sample = Array.from({ length: 200 }, () => rand() * 4 + 1);
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const a = bootstrapCI(sample, mean, { iterations: 500, seed: 3 });
  const b = bootstrapCI(sample, mean, { iterations: 500, seed: 3 });

  assert.deepEqual(a, b, "same seed must give the same interval");
  assert.ok(a.lo < a.point && a.point < a.hi, "CI must bracket the point estimate");

  // n = 1 is degenerate, not a crash.
  const one = bootstrapCI([2.5], mean);
  assert.ok(Number.isNaN(one.lo) && Number.isNaN(one.hi));
});

test("permutationP: real signal is significant, noise is not", () => {
  const rand = rng(11);
  const labels = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0 : 1));

  // A genuine 1.0-unit group difference should be detected.
  const real = labels.map((l) => l * 1.0 + rand() * 0.5);
  const gap = (vals: number[], labs: number[]) => {
    const g0 = vals.filter((_, i) => labs[i] === 0);
    const g1 = vals.filter((_, i) => labs[i] === 1);
    return g1.reduce((a, b) => a + b, 0) / g1.length - g0.reduce((a, b) => a + b, 0) / g0.length;
  };
  const pReal = permutationP(gap(real, labels), (r) => {
    const shuffled = [...labels].sort(() => r() - 0.5);
    return gap(real, shuffled);
  }, { iterations: 400 });
  assert.ok(pReal < 0.05, `real effect should be significant, got p=${pReal}`);

  // Pure noise should not be.
  const noise = labels.map(() => rand());
  const pNoise = permutationP(gap(noise, labels), (r) => {
    const shuffled = [...labels].sort(() => r() - 0.5);
    return gap(noise, shuffled);
  }, { iterations: 400 });
  assert.ok(pNoise > 0.05, `noise should not be significant, got p=${pNoise}`);

  // p is never exactly zero.
  assert.ok(permutationP(1e9, () => 0, { iterations: 100 }) > 0);
});
