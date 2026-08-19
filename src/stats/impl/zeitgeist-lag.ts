/**
 * S11 — "First-week or two-years-later."
 *
 * How long after release the user actually watches new films.
 *
 * Restricted to films watched within NEW_RELEASE_WINDOW_DAYS of release, because a
 * catalogue viewing of a 1975 film would otherwise contribute a fifty-year "lag"
 * and swamp everything. So the stat is about NEW RELEASES specifically, and the
 * copy says so rather than implying it covers all viewing.
 *
 * An earlier version cut on "released after the user started logging", which is
 * subtly wrong: a catch-up viewer's earliest films were by construction released
 * before they joined, so that rule gutted the sample of precisely the people the
 * stat is meant to identify. A fixed window is independent of viewing speed.
 *
 * The unavoidable caveat: TMDB's primary release_date is frequently the festival
 * or US date rather than a local one. For a non-US viewer that systematically
 * inflates lag, sometimes by months. Reported, not corrected — correcting it would
 * need a region we do not have.
 */
import type { StatContext } from "../context.ts";
import { median, quantile } from "../primitives.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

const DAY_MS = 86_400_000;

/** Films watched inside this window of release count as new-release viewing. */
export const NEW_RELEASE_WINDOW_DAYS = 3 * 365;
/** In-window films needed before reporting. */
export const LAG_MIN_FILMS = 30;
/** Median lag at or below this makes someone an opening-week viewer. */
export const PROMPT_DAYS = 14;
/** Median lag at or above this makes someone a catch-up viewer. */
export const LATE_DAYS = 180;

export type ZeitgeistLag = {
  medianDays: number | null;
  p25: number | null;
  p75: number | null;
  /** Share watched within the first week of release. */
  openingWeekShare: number;
  n: number;
  /** Films excluded as catalogue viewing — watched long after release. */
  catalogueExcluded: number;
  /** Films excluded for a watched date before TMDB's release date. */
  negativeLagExcluded: number;
};

export function zeitgeistLag(ctx: StatContext): StatResult<ZeitgeistLag> {
  const d = computeZeitgeistLag(ctx);

  if (d.n < LAG_MIN_FILMS || d.medianDays == null) {
    return none(
      d,
      `You have only logged ${d.n} films watched within three years of release, which is too few to ` +
        `say how quickly you get to new releases. ${d.catalogueExcluded} of your films were catalogue ` +
        `viewing, watched long after they came out.`,
    );
  }

  const pct = Math.round(d.openingWeekShare * 100);
  const caveat =
    ` Measured against TMDB's release date, which is often the festival or US date — if you are ` +
    `not watching in the US this overstates your lag.`;

  if (d.medianDays <= PROMPT_DAYS) {
    return strong(
      d,
      `You watch new releases almost immediately: median ${d.medianDays} days after release, and ` +
        `${pct}% within the opening week. Of new releases only — this ignores your catalogue ` +
        `viewing.${caveat}`,
      { title: "You watch things the week they land" },
    );
  }

  if (d.medianDays >= LATE_DAYS) {
    return strong(
      d,
      `You are a catch-up viewer: median ${Math.round(d.medianDays / 30)} months after release, with ` +
        `only ${pct}% caught in the opening week. Of new releases only.${caveat}`,
      { title: "You get there eventually" },
    );
  }

  return weak(
    d,
    `You get to new releases in a median of ${d.medianDays} days, with ${pct}% inside the opening ` +
      `week — neither a first-night viewer nor a straggler.${caveat}`,
    { title: "How fast you get to new releases" },
  );
}

function computeZeitgeistLag(ctx: StatContext): ZeitgeistLag {
  const dated = ctx.summary.diary.filter((e) => e.cleanDated && e.watchedDate);

  const lags: number[] = [];
  let catalogueExcluded = 0;
  let negativeLagExcluded = 0;

  for (const e of dated) {
    const film = ctx.byKey.get(e.filmKey)?.film;
    if (!film?.releaseDate) continue;

    const lag = Math.round((Date.parse(e.watchedDate!) - Date.parse(film.releaseDate)) / DAY_MS);

    // Negative lags are festival screenings or bad TMDB dates. Dropped rather
    // than clamped to zero, which would fake an opening-week viewer.
    if (lag < 0) {
      negativeLagExcluded++;
      continue;
    }
    if (lag > NEW_RELEASE_WINDOW_DAYS) {
      catalogueExcluded++;
      continue;
    }
    lags.push(lag);
  }

  const openingWeek = lags.filter((l) => l <= 7).length;

  return {
    medianDays: lags.length > 0 ? Math.round(median(lags)) : null,
    p25: lags.length > 0 ? Math.round(quantile(lags, 0.25)) : null,
    p75: lags.length > 0 ? Math.round(quantile(lags, 0.75)) : null,
    openingWeekShare: lags.length === 0 ? 0 : openingWeek / lags.length,
    n: lags.length,
    catalogueExcluded,
    negativeLagExcluded,
  };
}
