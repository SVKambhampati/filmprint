/**
 * S12 — "Do you reward length?"
 *
 * The user's runtime-to-rating association, compared against the CROWD's
 * runtime-to-score association on the SAME films.
 *
 * The comparison is what makes it includable at all. Long films are
 * disproportionately prestige and awards films, so a raw correlation between
 * runtime and rating mostly measures a genre confound. Differencing against the
 * crowd on an identical film set absorbs most of that: whatever bias makes long
 * films look good to everyone applies to both series.
 *
 * Reported as association, never as preference — and with an interval, because
 * the effect is typically small and unstable.
 */
import type { StatContext } from "../context.ts";
import { kendallTauB, bootstrapCI, type Interval } from "../primitives.ts";
import { MIN_VOTE_COUNT } from "../calibration.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Difference in tau worth calling a real divergence from the crowd. */
export const NOTABLE_DELTA = 0.08;

export type RuntimePrestige = {
  /** tau-b between runtime and the user's rating. */
  userTau: number;
  /** tau-b between runtime and the crowd's score, same films. */
  crowdTau: number;
  /** userTau - crowdTau. Positive means you reward length more than the crowd. */
  delta: number;
  deltaCI: Interval;
  n: number;
};

export function runtimePrestige(ctx: StatContext): StatResult<RuntimePrestige> {
  const d = computeRuntimePrestige(ctx);

  if (d.n < 30 || !Number.isFinite(d.delta)) {
    return none(
      d,
      "Too few of your films have both a runtime and a comparable crowd score for this to say " +
        "anything about how you treat length.",
    );
  }

  // The interval crossing zero is the honest reason to withhold a claim.
  const crossesZero = !Number.isFinite(d.deltaCI.lo) || (d.deltaCI.lo <= 0 && d.deltaCI.hi >= 0);

  if (Math.abs(d.delta) >= NOTABLE_DELTA && !crossesZero) {
    const dir = d.delta > 0 ? "more" : "less";
    return strong(
      d,
      `You reward length ${dir} than the crowd does. On the same ${d.n} films, runtime tracks your ` +
        `ratings at tau ${d.userTau.toFixed(2)} against their ${d.crowdTau.toFixed(2)} ` +
        `(difference ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(2)}, 95% CI ` +
        `${d.deltaCI.lo.toFixed(2)} to ${d.deltaCI.hi.toFixed(2)}). Association, not preference — ` +
        `long films are also disproportionately prestige films.`,
    );
  }

  return weak(
    d,
    `You treat runtime about the way everyone else does (tau ${d.userTau.toFixed(2)} against the ` +
      `crowd's ${d.crowdTau.toFixed(2)} on the same ${d.n} films, difference within noise). Length is ` +
      `not doing secret work in your ratings.`,
    { title: "Length doesn't sway you" },
  );
}

function computeRuntimePrestige(ctx: StatContext): RuntimePrestige {
  const usable = ctx.rated.filter(
    (r) => r.film.runtime != null && r.film.runtime > 0 && r.film.voteCount >= MIN_VOTE_COUNT && r.film.voteAverage > 0,
  );

  const empty: RuntimePrestige = { userTau: NaN, crowdTau: NaN, delta: NaN, deltaCI: { point: NaN, lo: NaN, hi: NaN }, n: usable.length };
  if (usable.length < 2) return empty;

  const triples = usable.map((r) => ({ runtime: r.film.runtime!, rating: r.rating, crowd: r.film.voteAverage }));

  const tauFor = (rows: readonly typeof triples[number][], pick: (t: typeof triples[number]) => number) =>
    kendallTauB(rows.map((t) => t.runtime), rows.map(pick));

  const userTau = tauFor(triples, (t) => t.rating);
  const crowdTau = tauFor(triples, (t) => t.crowd);

  // Bootstrap the DIFFERENCE, not each tau separately: the two series are paired
  // on the same films, so resampling them together preserves that dependence.
  const deltaCI = bootstrapCI(
    triples,
    (sample) => tauFor(sample, (t) => t.rating) - tauFor(sample, (t) => t.crowd),
    { iterations: 400, seed: 29 },
  );

  return { userTau, crowdTau, delta: userTau - crowdTau, deltaCI, n: triples.length };
}
