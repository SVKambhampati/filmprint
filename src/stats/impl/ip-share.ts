/**
 * S6 — "How much of what you watch is IP."
 *
 * Share of films belonging to a TMDB collection, trended by the year the user
 * watched them.
 *
 * THE LEVEL IS UNRELIABLE; THE TREND IS NOT.
 *
 * `belongs_to_collection` is inconsistently populated and skews heavily toward
 * Hollywood franchises — non-English series are badly under-tagged, and sequels
 * frequently sit outside their own collection. So an absolute "38% of your viewing
 * is IP" is not defensible.
 *
 * The WITHIN-USER trend is, because the tagging bias is roughly constant across
 * one person's own years. If a user's share doubles between 2018 and 2024, that is
 * a change in them, not a change in TMDB's metadata. So this reports direction and
 * downplays level, and says as much.
 */
import type { StatContext } from "../context.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Films needed in a year before its share is estimated. */
export const YEAR_MIN_FILMS = 40;
/** Change in share worth calling a trend, in percentage points. */
export const TREND_POINTS = 10;

export type YearShare = { year: number; films: number; inCollection: number; share: number };

export type IpShare = {
  years: YearShare[];
  first: YearShare | null;
  last: YearShare | null;
  /** last.share - first.share, in percentage points. */
  changePoints: number;
  overallShare: number;
};

export function ipShare(ctx: StatContext): StatResult<IpShare> {
  const d = computeIpShare(ctx);

  if (d.years.length < 2 || !d.first || !d.last) {
    return none(
      d,
      `You need two years with ${YEAR_MIN_FILMS}+ reliably-dated films before a franchise trend means ` +
        `anything. A single year's share would mostly measure TMDB's patchy franchise tagging rather ` +
        `than your viewing.`,
    );
  }

  const from = Math.round(d.first.share * 100);
  const to = Math.round(d.last.share * 100);
  const note =
    ` Treat the direction as real and the exact percentages as soft — TMDB under-tags non-English ` +
    `series, so the level is unreliable even though the trend within your own years is not.`;

  if (d.changePoints >= TREND_POINTS) {
    return strong(
      d,
      `Franchise films are taking over your viewing: ${from}% in ${d.first.year}, ${to}% in ` +
        `${d.last.year}.${note}`,
      { title: "Your viewing is getting more franchised", tone: "unflattering" },
    );
  }

  if (d.changePoints <= -TREND_POINTS) {
    return strong(
      d,
      `You are moving away from franchises: ${from}% of your viewing in ${d.first.year} belonged to a ` +
        `series, against ${to}% in ${d.last.year}.${note}`,
      { title: "You're moving away from franchises", tone: "flattering" },
    );
  }

  return weak(
    d,
    `Your franchise share has held steady, ${from}% in ${d.first.year} against ${to}% in ` +
      `${d.last.year}. Whatever else has changed about your viewing, this has not.${note}`,
    { title: "Your franchise share is steady" },
  );
}

function computeIpShare(ctx: StatContext): IpShare {
  const perYear = new Map<number, { films: number; inCollection: number }>();
  let total = 0;
  let totalInCollection = 0;

  for (const e of ctx.summary.diary) {
    if (!e.cleanDated || !e.watchedDate) continue;
    const film = ctx.byKey.get(e.filmKey)?.film;
    if (!film) continue;
    const year = Number.parseInt(e.watchedDate.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;

    const bucket = perYear.get(year) ?? { films: 0, inCollection: 0 };
    bucket.films++;
    total++;
    if (film.collectionId != null) {
      bucket.inCollection++;
      totalInCollection++;
    }
    perYear.set(year, bucket);
  }

  const years: YearShare[] = [...perYear.entries()]
    .filter(([, v]) => v.films >= YEAR_MIN_FILMS)
    .map(([year, v]) => ({ year, films: v.films, inCollection: v.inCollection, share: v.inCollection / v.films }))
    .sort((a, b) => a.year - b.year);

  const first = years[0] ?? null;
  const last = years[years.length - 1] ?? null;

  return {
    years,
    first,
    last,
    changePoints: first && last ? (last.share - first.share) * 100 : NaN,
    overallShare: total === 0 ? 0 : totalInCollection / total,
  };
}
