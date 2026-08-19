/**
 * S7 — "Your impossible days."
 *
 * Days whose logged runtime exceeds what a day physically holds. Almost always a
 * CSV import rather than a lie, so the tone stays playful.
 *
 * Tested on total RUNTIME, not film count: six shorts in a day is real, and a
 * festival day is real. Twenty-nine hours of cinema is not.
 */
import type { StatContext } from "../context.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Minutes of logged runtime in one day beyond which the day is impossible. */
export const IMPOSSIBLE_MINUTES = 20 * 60;
/** A long but survivable day — worth showing, not worth calling impossible. */
export const MARATHON_MINUTES = 12 * 60;

export type Day = { date: string; films: number; minutes: number; unknownRuntimes: number };

export type ImpossibleDays = {
  impossible: Day[];
  marathons: Day[];
  busiest: Day | null;
  daysLogged: number;
};

export function impossibleDays(ctx: StatContext): StatResult<ImpossibleDays> {
  const d = computeImpossibleDays(ctx);

  if (d.daysLogged === 0) {
    return none(d, "Your diary has no dated entries, so there are no days to look at.");
  }

  if (d.impossible.length > 0) {
    const worst = d.impossible[0]!;
    return strong(
      d,
      `On ${worst.date} your diary claims ${worst.films} films and ` +
        `${(worst.minutes / 60).toFixed(0)} hours of runtime. ` +
        `${d.impossible.length === 1 ? "That day is" : `${d.impossible.length} of your days are`} ` +
        `physically impossible — which is what a bulk import looks like from the outside.`,
    );
  }

  if (d.marathons.length > 0) {
    const worst = d.marathons[0]!;
    return weak(
      d,
      `Your heaviest day was ${worst.date}: ${worst.films} films, ${(worst.minutes / 60).toFixed(1)} hours. ` +
        `Long, but survivable — nothing in your diary is physically impossible.`,
      { title: "Your heaviest day" },
    );
  }

  const busiest = d.busiest!;
  return weak(
    d,
    `Your busiest day was ${busiest.date} with ${busiest.films} ` +
      `${busiest.films === 1 ? "film" : "films"} and ${(busiest.minutes / 60).toFixed(1)} hours. ` +
      `Your diary is entirely plausible, which is rarer than you would think.`,
    { title: "Your diary is honest", tone: "flattering" },
  );
}

function computeImpossibleDays(ctx: StatContext): ImpossibleDays {
  const perDay = new Map<string, { films: number; minutes: number; unknownRuntimes: number }>();

  for (const e of ctx.summary.diary) {
    if (!e.watchedDate) continue;
    const day = perDay.get(e.watchedDate) ?? { films: 0, minutes: 0, unknownRuntimes: 0 };
    day.films++;
    const runtime = ctx.byKey.get(e.filmKey)?.film.runtime ?? null;
    if (runtime == null) day.unknownRuntimes++;
    else day.minutes += runtime;
    perDay.set(e.watchedDate, day);
  }

  const days: Day[] = [...perDay.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => b.minutes - a.minutes);

  return {
    impossible: days.filter((d) => d.minutes >= IMPOSSIBLE_MINUTES),
    marathons: days.filter((d) => d.minutes >= MARATHON_MINUTES && d.minutes < IMPOSSIBLE_MINUTES),
    busiest: days[0] ?? null,
    daysLogged: days.length,
  };
}
