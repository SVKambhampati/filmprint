/**
 * H4 — "Your invisible signature."
 *
 * The below-the-line collaborators and recurring themes a user reliably responds
 * to without ever having noticed. Not directors: directors are the thing people
 * already know about themselves.
 *
 * THE HAZARD THIS STAT EXISTS AROUND
 *
 * Naively computed, a crew stat is a DIRECTOR stat wearing a better job title.
 * Roger Deakins looks like your favourite cinematographer because you like
 * Villeneuve and the Coens; Jung Jae-il looks like your favourite composer
 * because you like Bong Joon-ho. Film-literate users spot this instantly and it
 * discredits the whole page.
 *
 * The control here is the design spec's own fallback: a crew member only
 * qualifies if their films in the user's library span MIN_DISTINCT_DIRECTORS
 * different directors. That does not fully residualise the director effect, but
 * it does guarantee the signal is not carried by a single working relationship,
 * which is the failure mode that actually embarrasses you.
 *
 * Keywords carry a different hazard: without a blocklist every user's "recurring
 * theme" is "aftercreditsstinger" or "based on novel or book".
 */
import type { StatContext } from "../context.ts";
import { shrink } from "../primitives.ts";
import { SHRINK_K } from "../../hygiene/thresholds.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

/** Films with a crew member before they can be judged. */
export const CREW_MIN_FILMS = 4;
/** Distinct directors those films must span, so this is not a director stat. */
export const MIN_DISTINCT_DIRECTORS = 3;
/** Films sharing a keyword before it can be a "theme". */
export const KEYWORD_MIN_FILMS = 5;
/** Lift worth calling a signature, in stars. */
export const SIGNATURE_MIN_LIFT = 0.25;

/**
 * TMDB keywords that describe a film's PACKAGING rather than its content.
 *
 * Without this list, every user's recurring theme is a credits stinger. These are
 * structural, production, or format tags — real enough, but they say nothing about
 * what somebody is drawn to.
 */
export const KEYWORD_BLOCKLIST = new Set([
  "aftercreditsstinger",
  "duringcreditsstinger",
  "based on novel or book",
  "based on true story",
  "based on comic",
  "based on comic book",
  "based on young adult novel",
  "based on video game",
  "based on play or musical",
  "based on manga",
  "based on short story",
  "woman director",
  "sequel",
  "prequel",
  "remake",
  "reboot",
  "spin off",
  "live action remake",
  "imax",
  "3d",
  "anime",
  "interquel",
  "shared universe",
  "cinematic universe",
  "based on tv series",
  "adapted from a book",
]);

export type Signature = {
  job: string;
  personId: number;
  name: string;
  films: number;
  distinctDirectors: number;
  lift: number;
  topFilms: string[];
};

export type Theme = { keyword: string; films: number; lift: number; topFilms: string[] };

export type InvisibleSignature = {
  /** Best qualifying collaborator per job, highest lift first. */
  signatures: Signature[];
  themes: Theme[];
  /** Crew who had enough films but failed the distinct-director test. */
  rejectedAsDirectorProxy: { name: string; job: string; films: number; distinctDirectors: number }[];
};

const JOBS = ["Director of Photography", "Original Music Composer", "Editor"] as const;

const JOB_LABELS: Record<string, string> = {
  "Director of Photography": "cinematographer",
  "Original Music Composer": "composer",
  Editor: "editor",
};

/**
 * Job-specific verbs. A generic "shot or scored by" is wrong for whichever job
 * it is not — a cinematographer did not score anything.
 */
const JOB_VERBS: Record<string, string> = {
  "Director of Photography": "shot by",
  "Original Music Composer": "scored by",
  Editor: "cut by",
};

export function invisibleSignature(ctx: StatContext): StatResult<InvisibleSignature> {
  const d = computeInvisibleSignature(ctx);

  const top = d.signatures[0];
  if (top) {
    const label = JOB_LABELS[top.job] ?? top.job;
    return strong(
      d,
      `You have seen ${top.films} films ${JOB_VERBS[top.job] ?? "worked on by"} ${top.name} — your ` +
        `${label} — across ` +
        `${top.distinctDirectors} different directors, and you rate them ` +
        `${top.lift.toFixed(2)} stars above your own average. You have almost certainly never ` +
        `thought about their name.`,
    );
  }

  if (d.themes.length > 0) {
    const t = d.themes[0]!;
    return weak(
      d,
      `No single collaborator recurs often enough across enough directors to be a signature, but a ` +
        `theme does: ${t.films} of your films are tagged "${t.keyword}", and you rate them ` +
        `${t.lift.toFixed(2)} stars above your average.`,
      { title: "Your recurring theme" },
    );
  }

  if (d.rejectedAsDirectorProxy.length > 0) {
    const r = d.rejectedAsDirectorProxy[0]!;
    return none(
      d,
      `No hidden signature yet. ${r.name} appears in ${r.films} of your films, but across only ` +
        `${r.distinctDirectors} ${r.distinctDirectors === 1 ? "director" : "directors"} — that is your ` +
        `taste in directors showing through, not a separate preference.`,
    );
  }

  return none(
    d,
    `No cinematographer, composer or editor appears in ${CREW_MIN_FILMS} or more of your films yet. ` +
      `This one needs a deeper library before it can say anything.`,
  );
}

function computeInvisibleSignature(ctx: StatContext): InvisibleSignature {
  type Acc = { name: string; job: string; films: { name: string; rating: number }[]; directors: Set<number> };
  const byPerson = new Map<string, Acc>();

  for (const r of ctx.rated) {
    const crew = ctx.crew.get(r.film.tmdbId) ?? [];
    const directorIds = crew.filter((c) => c.job === "Director").map((c) => c.id);

    for (const c of crew) {
      if (!JOBS.includes(c.job as (typeof JOBS)[number])) continue;
      const key = `${c.id}:${c.job}`;
      const acc = byPerson.get(key) ?? { name: c.name, job: c.job, films: [], directors: new Set<number>() };
      acc.films.push({ name: r.name, rating: r.rating });
      for (const dId of directorIds) acc.directors.add(dId);
      byPerson.set(key, acc);
    }
  }

  const signatures: Signature[] = [];
  const rejectedAsDirectorProxy: InvisibleSignature["rejectedAsDirectorProxy"] = [];

  for (const [key, acc] of byPerson) {
    if (acc.films.length < CREW_MIN_FILMS) continue;
    const [idStr] = key.split(":");
    const personId = Number(idStr);
    const distinctDirectors = acc.directors.size;

    if (distinctDirectors < MIN_DISTINCT_DIRECTORS) {
      rejectedAsDirectorProxy.push({ name: acc.name, job: acc.job, films: acc.films.length, distinctDirectors });
      continue;
    }

    const raw = acc.films.reduce((a, f) => a + f.rating, 0) / acc.films.length;
    const lift = shrink(raw, acc.films.length, ctx.userMean, SHRINK_K) - ctx.userMean;
    if (lift < SIGNATURE_MIN_LIFT) continue;

    signatures.push({
      job: acc.job,
      personId,
      name: acc.name,
      films: acc.films.length,
      distinctDirectors,
      lift,
      topFilms: [...acc.films].sort((a, b) => b.rating - a.rating).slice(0, 3).map((f) => f.name),
    });
  }

  signatures.sort((a, b) => b.lift - a.lift);
  rejectedAsDirectorProxy.sort((a, b) => b.films - a.films);

  // Themes, with the packaging keywords removed.
  const byKeyword = new Map<string, { name: string; rating: number }[]>();
  for (const r of ctx.rated) {
    for (const k of ctx.keywords.get(r.film.tmdbId) ?? []) {
      if (KEYWORD_BLOCKLIST.has(k.toLowerCase())) continue;
      const list = byKeyword.get(k) ?? [];
      list.push({ name: r.name, rating: r.rating });
      byKeyword.set(k, list);
    }
  }

  const themes: Theme[] = [...byKeyword.entries()]
    .filter(([, films]) => films.length >= KEYWORD_MIN_FILMS)
    .map(([keyword, films]) => {
      const raw = films.reduce((a, f) => a + f.rating, 0) / films.length;
      return {
        keyword,
        films: films.length,
        lift: shrink(raw, films.length, ctx.userMean, SHRINK_K) - ctx.userMean,
        topFilms: [...films].sort((a, b) => b.rating - a.rating).slice(0, 3).map((f) => f.name),
      };
    })
    .filter((t) => t.lift >= SIGNATURE_MIN_LIFT)
    .sort((a, b) => b.lift - a.lift);

  return { signatures, themes, rejectedAsDirectorProxy };
}
