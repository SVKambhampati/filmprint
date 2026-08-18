/**
 * Resolving a Letterboxd CSV row to a TMDB id.
 *
 * The export gives us Name, Year, and a Letterboxd URI. The URI's slug is a
 * stable key, but it is OUR cache key only — it does not contain a TMDB id, and
 * as of December 2025 Letterboxd blocks scrapers, so we cannot read it off their
 * film pages. Everything is resolved from Name + Year against TMDB search.
 *
 * The important property: matching is solved once per FILM, never once per USER.
 * A resolved slug is written to the slug_map table and every later user gets an
 * exact hit. Match quality is an asset that compounds.
 */

/** Strip the slug out of a Letterboxd URI. Returns null for non-film entries. */
export function slugFromUri(uri: string): string | null {
  // Expected: https://letterboxd.com/film/<slug>/
  const m = /letterboxd\.com\/film\/([^/?#]+)/i.exec(uri.trim());
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

const LEADING_ARTICLES = ["the", "a", "an", "le", "la", "les", "el", "il", "lo", "der", "die", "das"];

/**
 * Aggressive title normalisation for comparison only. Never display the result.
 * Strips diacritics, punctuation, leading articles, and a trailing year.
 */
export function normalizeTitle(title: string): string {
  let s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[&]/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  s = s.replace(/\s+\d{4}$/, "").trim();
  for (const article of LEADING_ARTICLES) {
    if (s.startsWith(article + " ")) {
      s = s.slice(article.length + 1);
      break;
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Dice coefficient over character bigrams. 1 = identical, 0 = nothing shared. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const count = bigrams.get(g) ?? 0;
    if (count > 0) {
      bigrams.set(g, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

export type MatchMethod = "exact" | "year_slack" | "fuzzy" | "unmatched";

export type Candidate = {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  vote_count: number;
};

export type MatchOutcome = {
  tmdbId: number | null;
  confidence: number;
  method: MatchMethod;
  /** Runner-up score, when close. A small gap means the match is a coin flip. */
  runnerUp: number | null;
};

/** Below this we refuse to guess and record the row as unmatched. */
export const ACCEPT_THRESHOLD = 0.82;

/**
 * Score one candidate against the CSV row.
 *
 * Year agreement matters a lot: remakes and re-releases share titles, and the
 * Letterboxd year is generally reliable. But TMDB's release_date is sometimes a
 * festival or re-release date, so a one-year miss is only lightly penalised.
 */
export function scoreCandidate(
  csvTitle: string,
  csvYear: number | null,
  candidate: Candidate,
  slug?: string | null,
): number {
  const wanted = normalizeTitle(csvTitle);
  const titleScore = Math.max(
    diceSimilarity(wanted, normalizeTitle(candidate.title)),
    diceSimilarity(wanted, normalizeTitle(candidate.original_title)),
  );

  const candYear = Number.parseInt(candidate.release_date?.slice(0, 4) ?? "", 10);
  let yearFactor: number;
  if (!csvYear || !Number.isFinite(candYear)) {
    yearFactor = 0.88; // unknown on one side: mild penalty, not disqualifying
  } else {
    const gap = Math.abs(candYear - csvYear);
    yearFactor = gap === 0 ? 1 : gap === 1 ? 0.94 : gap === 2 ? 0.72 : 0.4;
  }

  // The slug frequently encodes the normalised title (and sometimes the year for
  // disambiguation), so agreement with it is a free extra signal.
  let slugBonus = 0;
  if (slug) {
    const slugText = normalizeTitle(slug.replace(/-/g, " "));
    if (slugText.length > 2 && diceSimilarity(slugText, normalizeTitle(candidate.title)) > 0.9) {
      slugBonus = 0.03;
    }
  }

  return Math.min(1, titleScore * yearFactor + slugBonus);
}

/** Pick the best candidate, or decline. */
export function chooseMatch(
  csvTitle: string,
  csvYear: number | null,
  candidates: readonly Candidate[],
  slug?: string | null,
): MatchOutcome {
  if (candidates.length === 0) {
    return { tmdbId: null, confidence: 0, method: "unmatched", runnerUp: null };
  }

  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(csvTitle, csvYear, c, slug) }))
    // Tie-break toward the better-known film: with identical titles and years,
    // the one with more votes is almost always the one a user logged.
    .sort((a, b) => b.score - a.score || b.c.vote_count - a.c.vote_count);

  const best = scored[0]!;
  const runnerUp = scored[1]?.score ?? null;

  if (best.score < ACCEPT_THRESHOLD) {
    return { tmdbId: null, confidence: best.score, method: "unmatched", runnerUp };
  }

  const bestYear = Number.parseInt(best.c.release_date?.slice(0, 4) ?? "", 10);
  const exactYear = csvYear != null && bestYear === csvYear;
  const nearTitle = normalizeTitle(csvTitle) === normalizeTitle(best.c.title) ||
    normalizeTitle(csvTitle) === normalizeTitle(best.c.original_title);

  const method: MatchMethod = nearTitle && exactYear ? "exact" : nearTitle ? "year_slack" : "fuzzy";

  return { tmdbId: best.c.id, confidence: best.score, method, runnerUp };
}
