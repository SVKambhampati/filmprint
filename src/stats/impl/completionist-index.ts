/**
 * S21 — "Franchises you abandon."
 *
 * For each collection the user has entered at least one film of, what share of it
 * they finished.
 *
 * THE HAZARD, WHICH IS NOT SUBTLE
 *
 * TMDB collection part lists include UNRELEASED entries. Counting them in the
 * denominator penalises a user for not having seen a film that does not exist —
 * someone who has watched all four released Dune films would be marked incomplete
 * because a fifth is announced. So the denominator is capped at released parts,
 * and a collection with nothing released is skipped entirely.
 *
 * Second hazard: `belongs_to_collection` is patchily populated, so a franchise the
 * user has genuinely finished may look partial because TMDB never tagged one of
 * its films. That direction of error is at least the safe one — it understates
 * completion rather than inventing it.
 */
import type { StatContext } from "../context.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Collections entered before the index is reported. */
export const MIN_COLLECTIONS = 5;
/** Released parts a collection needs before it counts as abandonable. */
export const MIN_RELEASED_PARTS = 2;

export type Franchise = {
  collectionId: number;
  name: string;
  seen: number;
  releasedParts: number;
  unreleasedParts: number;
  completion: number;
  /** Released films in the collection the user has not logged, oldest first. */
  missing: string[];
};

export type CompletionistIndex = {
  franchises: Franchise[];
  /** Collections entered and finished. */
  completed: Franchise[];
  /** Entered, more than one released film available, and stopped early. */
  abandoned: Franchise[];
  /** Share of entered franchises that were finished. */
  completionRate: number;
  /** The one they got deepest into without finishing. */
  deepestUnfinished: Franchise | null;
  /** Median number of films watched before stopping, across abandoned ones. */
  medianStopPoint: number | null;
};

export function completionistIndex(ctx: StatContext): StatResult<CompletionistIndex> {
  const d = computeCompletionistIndex(ctx);

  if (d.franchises.length < MIN_COLLECTIONS) {
    return none(
      d,
      `You have entered only ${d.franchises.length} franchises with more than one released film, ` +
        `which is too few to say anything about whether you finish them.`,
    );
  }

  const pct = Math.round(d.completionRate * 100);

  if (d.abandoned.length === 0) {
    return strong(
      d,
      `You finish what you start: all ${d.franchises.length} franchises you have entered, you have ` +
        `completed. That is genuinely unusual.`,
      { title: "You finish every franchise", tone: "flattering" },
    );
  }

  if (d.medianStopPoint != null && d.medianStopPoint <= 2 && d.abandoned.length >= 3) {
    // "abandon them at film 1" reads as abandoning DURING the first film. The
    // honest description is that they watch one and never come back.
    const how =
      d.medianStopPoint === 1
        ? "you watch one film and never come back"
        : `you stop after film ${d.medianStopPoint}`;
    return strong(
      d,
      `You sample franchises rather than follow them: ${how}. Of ${d.franchises.length} you have ` +
        `entered, you finished ${d.completed.length} (${pct}%) and walked away from ${d.abandoned.length}.`,
    );
  }

  return weak(
    d,
    `You have entered ${d.franchises.length} franchises and finished ${d.completed.length} of them ` +
      `(${pct}%).` +
      (d.deepestUnfinished
        ? ` The one you got deepest into without finishing is ${d.deepestUnfinished.name}: ` +
          `${d.deepestUnfinished.seen} of ${d.deepestUnfinished.releasedParts}.`
        : ""),
    { title: "How many franchises you finish" },
  );
}

function computeCompletionistIndex(ctx: StatContext): CompletionistIndex {
  const today = new Date().toISOString().slice(0, 10);
  const seenTmdbIds = new Set(ctx.rated.map((r) => r.film.tmdbId));

  // Collections the user has entered, from their own films.
  const entered = new Map<number, number>();
  for (const r of ctx.rated) {
    const cid = r.film.collectionId;
    if (cid == null) continue;
    entered.set(cid, (entered.get(cid) ?? 0) + 1);
  }

  const franchises: Franchise[] = [];
  for (const [collectionId, seen] of entered) {
    const parts = ctx.collectionParts.get(collectionId);
    if (!parts || parts.length === 0) continue; // never fetched: cannot judge

    const released = parts.filter((p) => p.releaseDate != null && p.releaseDate <= today);
    const unreleased = parts.length - released.length;
    // Denominator capped at RELEASED parts. Counting announced sequels would mark
    // a finished franchise incomplete.
    if (released.length < MIN_RELEASED_PARTS) continue;

    const missing = released
      .filter((p) => !seenTmdbIds.has(p.tmdbId))
      .sort((a, b) => (a.releaseDate ?? "").localeCompare(b.releaseDate ?? ""))
      .map((p) => p.title);

    franchises.push({
      collectionId,
      name: ctx.collectionNames.get(collectionId) ?? `Collection ${collectionId}`,
      // Capped: a rewatch or a mis-tag could otherwise push seen above the total.
      seen: Math.min(seen, released.length),
      releasedParts: released.length,
      unreleasedParts: unreleased,
      completion: Math.min(1, seen / released.length),
      missing,
    });
  }

  franchises.sort((a, b) => b.releasedParts - a.releasedParts);

  const completed = franchises.filter((f) => f.missing.length === 0);
  const abandoned = franchises.filter((f) => f.missing.length > 0);

  const stopPoints = abandoned.map((f) => f.seen).sort((a, b) => a - b);
  const medianStopPoint = stopPoints.length > 0 ? stopPoints[Math.floor(stopPoints.length / 2)]! : null;

  return {
    franchises,
    completed,
    abandoned,
    completionRate: franchises.length === 0 ? 0 : completed.length / franchises.length,
    deepestUnfinished: [...abandoned].sort((a, b) => b.seen - a.seen)[0] ?? null,
    medianStopPoint,
  };
}
