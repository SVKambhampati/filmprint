/**
 * H2 — "When your taste formed."
 *
 * Shrunk mean rating by film RELEASE year (not watch year). A peak is only
 * asserted when it clears the runner-up by a real margin on enough films;
 * otherwise the curve is shown with no claim attached.
 *
 * Honest framing matters here. Films from your teens are self-selected (you
 * already knew you loved them) and heavily rewatched, so this measures the era
 * of films you CHOSE to log and rate highly, not quality by era.
 */
import type { StatContext } from "../context.ts";
import { shrink } from "../primitives.ts";
import { SHRINK_K } from "../../hygiene/thresholds.ts";
import { releaseYearOf } from "../util.ts";

/**
 * Candidate bin widths, narrowest first.
 *
 * Width is chosen by films PER BIN, not by library size: 1,868 films spread over
 * a century is ~18 per year, so a total-count rule happily picks 1-year bins and
 * then reports an "era" built on six films.
 */
export const BIN_WIDTHS = [1, 5, 10, 20] as const;

/**
 * Median bin size required to CHOOSE a width.
 *
 * Deliberately higher than PEAK_MIN_BIN_N: the peak minimum asks "is this one bin
 * usable?", while width selection asks "are MOST bins usable?". Setting them
 * equal means a library averaging 18 films a year gets 1-year bins, and half the
 * curve is then built on single-digit counts.
 */
export const BIN_SELECT_MIN_MEDIAN = 25;
/** A bin needs this many films before it can be called a peak. */
export const PEAK_MIN_BIN_N = 15;
/** And it must beat the runner-up by this many stars. */
export const PEAK_MIN_MARGIN = 0.25;

export type Bin = {
  /** Start year of the bin. */
  year: number;
  width: number;
  n: number;
  rawMean: number;
  shrunkMean: number;
};

export type TasteCrystallization = {
  bins: Bin[];
  binWidth: number;
  /** Null when no bin clears the margin — say so rather than inventing a peak. */
  peak: { year: number; width: number; shrunkMean: number; n: number; topFilms: string[] } | null;
  /** Why there is no peak, when there isn't one. */
  noPeakReason: string | null;
};

/** Years present in the library, for choosing a bin width. */
function ratedYears(ctx: StatContext): number[] {
  const out: number[] = [];
  for (const r of ctx.rated) {
    const y = releaseYearOf(r.film.releaseDate);
    if (y != null) out.push(y);
  }
  return out;
}

/**
 * Narrowest width whose MEDIAN non-empty bin clears the peak minimum. Falls back
 * to the widest candidate when even that is too thin — better a coarse honest
 * curve than a fine dishonest one.
 */
export function chooseBinWidth(years: readonly number[]): number {
  for (const width of BIN_WIDTHS) {
    const counts = new Map<number, number>();
    for (const y of years) {
      const k = Math.floor(y / width) * width;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sizes = [...counts.values()].sort((a, b) => a - b);
    if (sizes.length === 0) continue;
    const med = sizes[Math.floor(sizes.length / 2)]!;
    if (med >= BIN_SELECT_MIN_MEDIAN) return width;
  }
  return BIN_WIDTHS[BIN_WIDTHS.length - 1]!;
}

export function tasteCrystallization(ctx: StatContext): TasteCrystallization {
  const width = chooseBinWidth(ratedYears(ctx));

  const buckets = new Map<number, { ratings: number[]; films: { name: string; rating: number }[] }>();
  for (const r of ctx.rated) {
    const y = releaseYearOf(r.film.releaseDate);
    if (y == null) continue;
    const key = Math.floor(y / width) * width;
    let b = buckets.get(key);
    if (!b) {
      b = { ratings: [], films: [] };
      buckets.set(key, b);
    }
    b.ratings.push(r.rating);
    b.films.push({ name: r.name, rating: r.rating });
  }

  const bins: Bin[] = [...buckets.entries()]
    .map(([year, b]) => {
      const raw = b.ratings.reduce((a, x) => a + x, 0) / b.ratings.length;
      return {
        year,
        width,
        n: b.ratings.length,
        rawMean: raw,
        shrunkMean: shrink(raw, b.ratings.length, ctx.userMean, SHRINK_K),
      };
    })
    .sort((a, b) => a.year - b.year);

  const eligible = bins.filter((b) => b.n >= PEAK_MIN_BIN_N).sort((a, b) => b.shrunkMean - a.shrunkMean);

  let peak: TasteCrystallization["peak"] = null;
  let noPeakReason: string | null = null;

  if (eligible.length === 0) {
    noPeakReason = `no era has ${PEAK_MIN_BIN_N}+ rated films yet`;
  } else if (eligible.length === 1) {
    const only = eligible[0]!;
    peak = { year: only.year, width, shrunkMean: only.shrunkMean, n: only.n, topFilms: topFilmsIn(ctx, only.year, width) };
  } else {
    const [best, second] = [eligible[0]!, eligible[1]!];
    if (best.shrunkMean - second.shrunkMean >= PEAK_MIN_MARGIN) {
      peak = { year: best.year, width, shrunkMean: best.shrunkMean, n: best.n, topFilms: topFilmsIn(ctx, best.year, width) };
    } else {
      noPeakReason =
        `your best era beats the runner-up by only ${(best.shrunkMean - second.shrunkMean).toFixed(2)} stars, ` +
        `which is inside the noise — your taste is evenly spread`;
    }
  }

  return { bins, binWidth: width, peak, noPeakReason };
}

function topFilmsIn(ctx: StatContext, binStart: number, width: number): string[] {
  return ctx.rated
    .filter((r) => {
      const y = releaseYearOf(r.film.releaseDate);
      return y != null && y >= binStart && y < binStart + width;
    })
    .sort((a, b) => b.rating - a.rating || b.film.voteCount - a.film.voteCount)
    .slice(0, 3)
    .map((r) => r.name);
}
