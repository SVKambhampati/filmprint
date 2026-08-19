/**
 * "Your watchlist graveyard."
 *
 * WHAT THIS IS NOT
 *
 * The original design called for watchlist HALF-LIFE: survival analysis on
 * time-from-added-to-watched, with a conversion rate by genre. That is not
 * computable from a Letterboxd export, and this was verified against a real one
 * rather than assumed:
 *
 *   watchlist ids also in watched.csv (by film id):   0
 *   watchlist films also in watched.csv (name+year):  0
 *   watchlist films also in diary.csv  (name+year):   0
 *
 * Letterboxd removes a film from the watchlist when you log it, and the export
 * contains only the CURRENT watchlist. So every converted film has left the file,
 * and the diary keeps no record of when it was added. Kaplan-Meier would see zero
 * events and nothing but censored observations.
 *
 * What IS observable is how long the survivors have sat there. That is an age
 * list, and it is honest — the twelve oldest posters were always the part people
 * screenshot anyway.
 *
 * Unreleased films are excluded throughout. A film added in 2025 that comes out
 * in 2028 is a wishlist entry, and counting it as neglect would be nonsense.
 */
import type { StatContext } from "../context.ts";
import { median } from "../primitives.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

const DAY_MS = 86_400_000;

/** Sat this long unwatched, and released, and it is in the graveyard. */
export const GRAVEYARD_DAYS = 365;

export type Entry = {
  name: string;
  addedDate: string;
  ageDays: number;
  releaseDate: string | null;
  posterPath: string | null;
};

export type WatchlistGraveyard = {
  /** Released, still unwatched, oldest first. */
  graveyard: Entry[];
  /** Released and on the list, however recently added. */
  released: Entry[];
  /** Not out yet — a wishlist, not a backlog. */
  unreleased: Entry[];
  medianAgeDays: number | null;
  oldest: Entry | null;
  total: number;
};

export function watchlistGraveyard(ctx: StatContext, today = new Date().toISOString().slice(0, 10)): StatResult<WatchlistGraveyard> {
  const d = computeWatchlistGraveyard(ctx, today);

  if (d.total === 0) {
    return none(d, "Your watchlist is empty. Either you watch what you mean to, or you never wrote it down.");
  }

  if (d.released.length === 0) {
    return none(
      d,
      `All ${d.total} films on your watchlist are unreleased. That is a wishlist, not a backlog — ` +
        `there is nothing here you are avoiding, only things that do not exist yet.`,
      { title: "Your watchlist is a wishlist", tone: "flattering" },
    );
  }

  if (d.graveyard.length === 0) {
    return weak(
      d,
      `Nothing on your watchlist has sat there a year. The oldest released film you have not got ` +
        `to is ${d.oldest!.name}, added ${d.oldest!.ageDays} days ago. Your list is genuinely a queue.`,
      { title: "Your watchlist is alive", tone: "flattering" },
    );
  }

  const oldest = d.graveyard[0]!;
  const years = (oldest.ageDays / 365).toFixed(1);
  return strong(
    d,
    `${d.graveyard.length} released ${d.graveyard.length === 1 ? "film has" : "films have"} sat on your ` +
      `watchlist for over a year. ${oldest.name} has been waiting ${years} years. ` +
      `Median age of what you have not got to: ${d.medianAgeDays} days.`,
  );
}

function computeWatchlistGraveyard(ctx: StatContext, today: string): WatchlistGraveyard {
  const nowMs = Date.parse(today);
  const released: Entry[] = [];
  const unreleased: Entry[] = [];

  for (const w of ctx.summary.watchlist) {
    // ctx.joined, NOT ctx.byKey: byKey is built from ratings, and a watchlist film
    // is by definition unwatched and therefore unrated.
    const film = ctx.joined.get(w.filmKey) ?? null;
    const releaseDate = film?.releaseDate ?? null;
    const entry: Entry = {
      name: w.name,
      addedDate: w.addedDate,
      ageDays: Math.max(0, Math.round((nowMs - Date.parse(w.addedDate)) / DAY_MS)),
      releaseDate,
      posterPath: film?.posterPath ?? null,
    };
    // No known release date is treated as unreleased: safer to under-accuse than
    // to call a film neglected when we cannot tell whether it exists.
    if (releaseDate && releaseDate <= today) released.push(entry);
    else unreleased.push(entry);
  }

  released.sort((a, b) => b.ageDays - a.ageDays);
  unreleased.sort((a, b) => b.ageDays - a.ageDays);

  return {
    graveyard: released.filter((e) => e.ageDays >= GRAVEYARD_DAYS),
    released,
    unreleased,
    medianAgeDays: released.length > 0 ? Math.round(median(released.map((e) => e.ageDays))) : null,
    oldest: released[0] ?? null,
    total: ctx.summary.watchlist.length,
  };
}
