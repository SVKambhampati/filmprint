/**
 * S5 — "Your comfort object."
 *
 * The most-rewatched film, plus the PROFILE difference between what the user
 * returns to and what they seek out. The profile comparison is the interesting
 * half: "your first watches average 2019, your rewatches average 2004."
 *
 * The rewatch flag is user-maintained and routinely forgotten, so every count
 * here is a LOWER BOUND. Never render "you have seen this 4 times" — the honest
 * claim is "at least 4".
 */
import type { StatContext } from "../context.ts";
import { median } from "../primitives.ts";
import { releaseYearOf } from "../util.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Below this many rewatch entries, show the top film only, no profile. */
export const PROFILE_MIN_REWATCHES = 10;

export type SideProfile = {
  n: number;
  medianReleaseYear: number | null;
  medianRuntime: number | null;
  topGenres: string[];
};

export type ComfortObject = {
  /** Most-rewatched film. Count is a lower bound. */
  top: { name: string; atLeastTimes: number; posterPath: string | null } | null;
  /** Non-null only when there are enough rewatch entries to compare profiles. */
  seeking: SideProfile | null;
  returning: SideProfile | null;
  rewatchEntries: number;
};

export function comfortObject(ctx: StatContext): StatResult<ComfortObject> {
  const d = computeComfortObject(ctx);

  if (!d.top) {
    return none(
      d,
      "You have never logged a rewatch. Either you always move forward, or you rewatch " +
        "without telling Letterboxd about it.",
    );
  }

  if (d.seeking && d.returning && d.seeking.medianReleaseYear && d.returning.medianReleaseYear) {
    const gap = d.seeking.medianReleaseYear - d.returning.medianReleaseYear;
    const direction =
      gap > 3
        ? `you seek out ${gap} years newer than you return to`
        : gap < -3
          ? `you return to films newer than the ones you seek out`
          : `your rewatches and first watches come from the same era`;
    return strong(
      d,
      `Your comfort object is ${d.top.name} — at least ${d.top.atLeastTimes} times. ` +
        `First watches average ${d.seeking.medianReleaseYear} and ${d.seeking.medianRuntime}m; ` +
        `rewatches average ${d.returning.medianReleaseYear} and ${d.returning.medianRuntime}m, so ${direction}.`,
    );
  }

  return weak(
    d,
    `Your comfort object is ${d.top.name} — at least ${d.top.atLeastTimes} times. ` +
      `With only ${d.rewatchEntries} logged rewatches there is not enough to compare what you ` +
      `return to against what you seek out.`,
  );
}

function computeComfortObject(ctx: StatContext): ComfortObject {
  const diary = ctx.summary.diary;
  const rewatches = diary.filter((e) => e.rewatch);

  // Most-rewatched film, by count of rewatch entries.
  const counts = new Map<string, { name: string; n: number }>();
  for (const e of rewatches) {
    const c = counts.get(e.filmKey) ?? { name: e.name, n: 0 };
    c.n++;
    counts.set(e.filmKey, c);
  }
  const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];

  const top = best
    ? {
        name: best[1].name,
        atLeastTimes: best[1].n,
        posterPath: ctx.rated.find((r) => r.filmKey === best[0])?.film.posterPath ?? null,
      }
    : null;

  if (rewatches.length < PROFILE_MIN_REWATCHES) {
    return { top, seeking: null, returning: null, rewatchEntries: rewatches.length };
  }

  const firstWatches = diary.filter((e) => !e.rewatch);
  return {
    top,
    seeking: sideProfile(ctx, firstWatches.map((e) => e.filmKey)),
    returning: sideProfile(ctx, rewatches.map((e) => e.filmKey)),
    rewatchEntries: rewatches.length,
  };
}

function sideProfile(ctx: StatContext, filmKeys: readonly string[]): SideProfile {
  const byKey = new Map(ctx.rated.map((r) => [r.filmKey, r] as const));
  const years: number[] = [];
  const runtimes: number[] = [];
  const genreCounts = new Map<string, number>();

  for (const k of filmKeys) {
    const r = byKey.get(k);
    if (!r) continue;
    const y = releaseYearOf(r.film.releaseDate);
    if (y != null) years.push(y);
    if (r.film.runtime != null) runtimes.push(r.film.runtime);
    for (const g of ctx.genres.get(r.film.tmdbId) ?? []) {
      genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
    }
  }

  return {
    n: filmKeys.length,
    medianReleaseYear: years.length > 0 ? Math.round(median(years)) : null,
    medianRuntime: runtimes.length > 0 ? Math.round(median(runtimes)) : null,
    topGenres: [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g),
  };
}
