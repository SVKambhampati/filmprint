/**
 * S14 — "What opened a language for you."
 *
 * For each non-English language, the first film logged in it, and whether that
 * film began a streak — more films in the same language within a year — or led
 * nowhere.
 *
 * Runs on the CLEAN-DATED subset only. For a backfiller, "first logged" is an
 * artifact of when they imported their history, not when they discovered a
 * cinema, and the entry point would be whichever film the importer happened to
 * write first.
 */
import type { StatContext } from "../context.ts";
import { languageName } from "./harshness-split.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

const DAY_MS = 86_400_000;
/** Further films in the same language within this window count as a streak. */
export const STREAK_WINDOW_DAYS = 365;
/** Films in the window needed to call it a streak rather than a one-off. */
export const STREAK_MIN_FILMS = 3;

export type EntryPoint = {
  language: string;
  languageLabel: string;
  film: string;
  watchedDate: string;
  rating: number | null;
  /** Films in the same language within STREAK_WINDOW_DAYS after this one. */
  followedBy: number;
  /** Total films in this language across the clean-dated subset. */
  total: number;
  startedStreak: boolean;
};

export type LanguageEntryPoints = {
  entryPoints: EntryPoint[];
  /** The entry point that opened the most viewing. */
  bestOpener: EntryPoint | null;
  /** Entry points that led nowhere — a language tried once and dropped. */
  deadEnds: EntryPoint[];
  cleanDatedUsed: number;
};

export function languageEntryPoints(ctx: StatContext): StatResult<LanguageEntryPoints> {
  const d = computeLanguageEntryPoints(ctx);

  if (d.entryPoints.length === 0) {
    return none(
      d,
      d.cleanDatedUsed === 0
        ? "Your diary has no reliably dated entries, so we cannot tell which film opened a language for you."
        : "Every reliably dated film in your diary is in one language, so there is no entry point to find.",
    );
  }

  if (d.bestOpener && d.bestOpener.startedStreak) {
    const dead = d.deadEnds[0];
    const contrast = dead
      ? ` ${dead.film} did not do the same for ${dead.languageLabel} — you never went back.`
      : "";
    return strong(
      d,
      `${d.bestOpener.film} opened ${d.bestOpener.languageLabel} cinema for you: ` +
        `${d.bestOpener.followedBy} more within a year.${contrast}`,
    );
  }

  if (d.deadEnds.length > 0) {
    const dead = d.deadEnds[0]!;
    return weak(
      d,
      `You have tried ${d.entryPoints.length} languages and none of them stuck. ` +
        `${dead.film} was your only ${dead.languageLabel} film — a door you opened once and closed.`,
      { title: "Languages you tried once" },
    );
  }

  return weak(
    d,
    `You watch across ${d.entryPoints.length} languages, but none of them started from a single film ` +
      `that pulled you in — your viewing spread gradually rather than through a gateway.`,
    { title: "No single film opened a language" },
  );
}

function computeLanguageEntryPoints(ctx: StatContext): LanguageEntryPoints {
  // Clean-dated only: a backfiller's "first logged" is an import artifact.
  const entries = ctx.summary.diary
    .filter((e) => e.cleanDated && e.watchedDate)
    .map((e) => ({ e, film: ctx.byKey.get(e.filmKey)?.film ?? null }))
    .filter((x): x is { e: (typeof ctx.summary.diary)[number]; film: NonNullable<typeof x.film> } => x.film != null)
    .sort((a, b) => a.e.watchedDate!.localeCompare(b.e.watchedDate!));

  const byLanguage = new Map<string, typeof entries>();
  for (const x of entries) {
    const lang = x.film.originalLanguage || "??";
    const list = byLanguage.get(lang) ?? [];
    list.push(x);
    byLanguage.set(lang, list);
  }

  const entryPoints: EntryPoint[] = [];
  for (const [language, films] of byLanguage) {
    if (language === "en") continue; // English is not a discovery
    const first = films[0]!;
    const firstMs = Date.parse(first.e.watchedDate!);
    const followedBy = films.filter(
      (x) => x !== first && Date.parse(x.e.watchedDate!) - firstMs <= STREAK_WINDOW_DAYS * DAY_MS,
    ).length;

    entryPoints.push({
      language,
      languageLabel: languageName(language),
      film: first.e.name,
      watchedDate: first.e.watchedDate!,
      rating: first.e.rating,
      followedBy,
      total: films.length,
      startedStreak: followedBy + 1 >= STREAK_MIN_FILMS,
    });
  }

  entryPoints.sort((a, b) => b.followedBy - a.followedBy);

  return {
    entryPoints,
    bestOpener: entryPoints[0] ?? null,
    deadEnds: entryPoints.filter((e) => e.total === 1),
    cleanDatedUsed: entries.length,
  };
}
