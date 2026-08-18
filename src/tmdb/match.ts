/**
 * Resolving a Letterboxd CSV row to a TMDB id.
 *
 * The export gives us Name, Year, and a Letterboxd URI. The URI's slug is a
 * stable key, but it is OUR cache key only — it does not contain a TMDB id, and
 * as of December 2025 Letterboxd blocks scrapers, so we cannot read it off their
 * film pages. Everything is resolved from Name + Year against TMDB search.
 *
 * The important property: matching is solved once per FILM, never once per USER.
 * A resolved film is written to the film_map table and every later user gets an
 * exact hit. Match quality is an asset that compounds.
 */

/**
 * Extract the identifier from a Letterboxd URI.
 *
 * Real exports use short links — `https://boxd.it/jUk4` — not the
 * `letterboxd.com/film/<slug>/` form. Both are accepted because older exports
 * and hand-entered data use the long form.
 *
 * CRITICAL: the short code's meaning depends on WHICH FILE it came from.
 * ratings.csv / watched.csv / watchlist.csv carry FILM ids; diary.csv carries
 * DIARY ENTRY ids, which live in a different id space entirely and share no
 * overlap with film ids. This function cannot tell them apart and does not try —
 * the caller knows which file it is reading. See normalize.ts.
 */
export function letterboxdId(uri: string): string | null {
  const t = uri.trim();
  if (t.length === 0) return null;

  const short = /boxd\.it\/([A-Za-z0-9]+)/.exec(t);
  if (short) return short[1]!;

  const long = /letterboxd\.com\/film\/([^/?#]+)/i.exec(t);
  if (long) return decodeURIComponent(long[1]!).toLowerCase();

  return null;
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

/**
 * Score for "the query is the candidate's title minus a subtitle".
 *
 * Letterboxd frequently carries the short theatrical title while TMDB carries
 * the full one: "Glass Onion" vs "Glass Onion: A Knives Out Mystery", "Wake Up
 * Dead Man" vs the same. Bigram similarity punishes that length gap hard enough
 * to push a correct match below the accept threshold.
 *
 * Deliberately capped below 1 so a genuine exact title always outranks a prefix
 * match — "Dune" must still prefer Dune over Dune: Part Two. And the year factor
 * still applies on top, so a prefix match with a wrong year is refused.
 */
const SUBTITLE_PREFIX_SCORE = 0.94;

function subtitlePrefixScore(wanted: string, candidate: string): number {
  if (wanted.length === 0 || candidate.length === 0) return 0;
  if (wanted === candidate) return 0; // exact matches are dice's job
  // Require a word boundary so "her" does not prefix-match "hereditary", and a
  // reasonable length so very short queries cannot swallow long titles.
  if (wanted.length < 5) return 0;
  const [shorter, longer] = wanted.length < candidate.length ? [wanted, candidate] : [candidate, wanted];
  if (!longer.startsWith(shorter + " ")) return 0;
  return SUBTITLE_PREFIX_SCORE;
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
 * Year gap tolerated when the title matches EXACTLY and no other candidate does.
 *
 * TMDB's primary release_date is often the wide or streaming release while
 * Letterboxd shows the festival premiere, and that gap runs to two or three
 * years (Am I OK? premiered at Sundance in 2022; TMDB holds 2024). A perfect
 * title match with no competitor should not be vetoed by that.
 *
 * Bounded, though: a unique exact title match a century away is a different
 * film, not a festival lag.
 */
export const EXACT_TITLE_MAX_YEAR_GAP = 3;

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
  const candTitle = normalizeTitle(candidate.title);
  const candOriginal = normalizeTitle(candidate.original_title);

  const titleScore = Math.max(
    diceSimilarity(wanted, candTitle),
    diceSimilarity(wanted, candOriginal),
    subtitlePrefixScore(wanted, candTitle),
    subtitlePrefixScore(wanted, candOriginal),
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

  const wanted = normalizeTitle(csvTitle);
  const isExactTitle = (c: Candidate) =>
    normalizeTitle(c.title) === wanted || normalizeTitle(c.original_title) === wanted;

  const bestYear = Number.parseInt(best.c.release_date?.slice(0, 4) ?? "", 10);
  const exactYear = csvYear != null && bestYear === csvYear;
  const nearTitle = isExactTitle(best.c);

  if (best.score < ACCEPT_THRESHOLD) {
    // The year is a RANKING signal, not a veto. When exactly one candidate's
    // title matches perfectly, there is no rival film to prefer instead, so a
    // release-date disagreement should not sink it — that is the festival-vs-
    // wide-release gap, not a wrong match. With two exact-title candidates
    // (Dune 1984 vs 2021) the year still decides, because the scores above
    // already ranked them.
    const exactTitleCount = candidates.filter(isExactTitle).length;
    const yearGap =
      csvYear != null && Number.isFinite(bestYear) ? Math.abs(bestYear - csvYear) : null;

    const rescuable =
      nearTitle &&
      exactTitleCount === 1 &&
      yearGap !== null &&
      yearGap <= EXACT_TITLE_MAX_YEAR_GAP;

    if (!rescuable) {
      return { tmdbId: null, confidence: best.score, method: "unmatched", runnerUp };
    }
    return { tmdbId: best.c.id, confidence: best.score, method: "year_slack", runnerUp };
  }

  const method: MatchMethod = nearTitle && exactYear ? "exact" : nearTitle ? "year_slack" : "fuzzy";

  return { tmdbId: best.c.id, confidence: best.score, method, runnerUp };
}
