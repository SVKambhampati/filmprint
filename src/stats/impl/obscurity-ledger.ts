/**
 * S10 — "Your best obscure finds."
 *
 * The flattering counterweight to the harshness split. Films the user rated
 * highly that few people have voted on.
 *
 * The whole difficulty is that vote_count is heavily recency- and English-biased:
 * a 1975 Japanese film has few TMDB votes because of TMDB's user demographics,
 * not because it is obscure. So vote_count is z-scored WITHIN decade x language
 * cohorts, which asks "obscure relative to films like it" instead of "obscure
 * relative to Marvel". Without that this stat degenerates into "you watch old
 * foreign films", which taste-radius already measures better.
 */
import type { StatContext } from "../context.ts";
import { mean, variance } from "../primitives.ts";
import { decadeOf, releaseYearOf } from "../util.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Only films rated at or above this count as a "find". */
export const FIND_MIN_RATING = 4.5;
/** A cohort needs this many films before its mean and SD mean anything. */
export const COHORT_MIN_N = 8;

/**
 * How far below its cohort a film must sit to count as a find.
 *
 * Without this the stat is just "your 4.5s, sorted by relative vote count", and
 * a user with few high ratings gets shown films that are MORE popular than their
 * cohort under a headline calling them obscure. Roughly the bottom third of a
 * normal distribution.
 */
export const FIND_MAX_Z = -0.5;

/**
 * Minimum log10 shortfall against the cohort mean. 0.4 is roughly "a third of
 * the votes of comparable films".
 *
 * A z-score alone is not enough: z flags the bottom third of ANY cohort by
 * construction, even one where every film has about 8,000 votes and nothing is
 * remotely obscure. Requiring an absolute gap as well means a "find" is a film
 * that genuinely few people have seen, not merely the least-seen of a popular set.
 */
export const FIND_MIN_LOG_GAP = 0.4;

export type Find = {
  name: string;
  rating: number;
  voteCount: number;
  /** Negative = fewer votes than its cohort. More negative = more obscure. */
  cohortZ: number;
  /** log10 shortfall against the cohort mean. 0.4 is about 3x fewer votes. */
  logGap: number;
  cohort: string;
  cohortN: number;
  posterPath: string | null;
};

export type ObscurityLedger = {
  /** Films that are genuinely under-voted for their cohort, most obscure first. */
  finds: Find[];
  /** Films that were rated highly but sat in a cohort too small to judge. */
  uncohorted: number;
  /** Highly-rated films considered. */
  candidates: number;
  /** Scored but not obscure enough to qualify. When finds is empty, say this. */
  notObscureEnough: number;
};

/** At or above this many qualifying finds, the stat has a real story. */
export const STRONG_FIND_COUNT = 3;

export function obscurityLedger(ctx: StatContext, limit = 10): StatResult<ObscurityLedger> {
  const d = computeObscurityLedger(ctx, limit);

  if (d.candidates === 0) {
    return none(d, `You have not rated anything ${FIND_MIN_RATING}★ or above yet.`);
  }

  if (d.finds.length === 0) {
    return none(
      d,
      `Every one of the ${d.candidates} films you rated ${FIND_MIN_RATING}★+ is well-known for ` +
        `its era and language. You have no obscure favourites — what you love, everyone loves.`,
    );
  }

  const top = d.finds[0]!;
  if (d.finds.length >= STRONG_FIND_COUNT) {
    return strong(
      d,
      `${d.finds.length} of your favourites are films almost nobody has voted on. The deepest cut ` +
        `is ${top.name}, with ${top.voteCount} votes — roughly a ${Math.round(10 ** top.logGap)}x ` +
        `shortfall against comparable films you watch.`,
    );
  }

  return weak(
    d,
    `One genuine deep cut: ${top.name}, at ${top.voteCount} votes. The rest of what you rate ` +
      `highly is well-travelled.`,
  );
}

function computeObscurityLedger(ctx: StatContext, limit = 10): ObscurityLedger {
  // Cohorts over ALL rated films, not just the highly-rated ones: the reference
  // distribution should describe the user's whole library.
  const cohortKey = (decade: number | null, lang: string) => `${decade ?? "unknown"}|${lang || "??"}`;

  const cohorts = new Map<string, number[]>();
  for (const r of ctx.rated) {
    if (r.film.voteCount <= 0) continue;
    const y = releaseYearOf(r.film.releaseDate);
    const key = cohortKey(y == null ? null : decadeOf(y), r.film.originalLanguage);
    const list = cohorts.get(key) ?? [];
    // log, because vote_count is heavily right-skewed.
    list.push(Math.log10(r.film.voteCount));
    cohorts.set(key, list);
  }

  const cohortStats = new Map<string, { mean: number; sd: number; n: number }>();
  for (const [key, logs] of cohorts) {
    if (logs.length < COHORT_MIN_N) continue;
    const v = variance(logs);
    cohortStats.set(key, { mean: mean(logs), sd: Number.isFinite(v) && v > 0 ? Math.sqrt(v) : 0, n: logs.length });
  }

  const candidates = ctx.rated.filter((r) => r.rating >= FIND_MIN_RATING && r.film.voteCount > 0);
  const finds: Find[] = [];
  let uncohorted = 0;

  for (const r of candidates) {
    const y = releaseYearOf(r.film.releaseDate);
    const key = cohortKey(y == null ? null : decadeOf(y), r.film.originalLanguage);
    const cs = cohortStats.get(key);
    if (!cs || cs.sd === 0) {
      uncohorted++;
      continue;
    }
    finds.push({
      name: r.name,
      rating: r.rating,
      voteCount: r.film.voteCount,
      cohortZ: (Math.log10(r.film.voteCount) - cs.mean) / cs.sd,
      logGap: cs.mean - Math.log10(r.film.voteCount),
      cohort: key,
      cohortN: cs.n,
      posterPath: r.film.posterPath,
    });
  }

  finds.sort((a, b) => a.cohortZ - b.cohortZ);
  // Both conditions: unusual for its cohort AND genuinely low-voted.
  const qualifying = finds.filter((f) => f.cohortZ <= FIND_MAX_Z && f.logGap >= FIND_MIN_LOG_GAP);
  return {
    finds: qualifying.slice(0, limit),
    uncohorted,
    candidates: candidates.length,
    notObscureEnough: finds.length - qualifying.length,
  };
}
