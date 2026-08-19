/**
 * H1 — "Harsh or contrarian?"
 *
 * Two ORTHOGONAL axes, which is the whole point:
 *
 *   level offset   — are you globally stingy or generous? Needs an external
 *                    anchor (see calibration.ts) because a within-set comparison
 *                    is structurally always zero.
 *   rank agreement — do you ORDER the same films the way the crowd does?
 *                    Scale-free, so correctly computed within-set.
 *
 * A user can be a harsh conformist (rankings match, ratings low), which is the
 * most common and least flattering result: most people who believe they are
 * contrarians are simply mean.
 */
import type { StatContext } from "../context.ts";
import { kendallTauB } from "../primitives.ts";
import { harshness, MIN_VOTE_COUNT, type Harshness } from "../calibration.ts";
import { percentileRanks } from "../util.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

export type Quadrant =
  | "harsh conformist"
  | "harsh contrarian"
  | "generous conformist"
  | "generous contrarian";

export type Disagreement = {
  name: string;
  userRating: number;
  crowdRating: number;
  /** User percentile minus crowd percentile, both within this user's film set. */
  rankGap: number;
  posterPath: string | null;
};

/**
 * Which films the verdict actually rests on.
 *
 * TMDB's vote counts are heavily English-biased, so the MIN_VOTE_COUNT filter
 * does not exclude a random half of a library — it excludes the non-English half
 * first. A verdict of "harsh conformist" computed that way may be true of a
 * user's Hollywood viewing and false of everything else, and saying "you are a
 * harsh conformist" full stop would be overclaiming.
 */
export type Coverage = {
  compared: number;
  rated: number;
  excluded: number;
  /** compared / rated. 1.0 means nothing was left out. */
  share: number;
  /** Languages losing the most films to the vote-count filter, worst first. */
  worstExcluded: { language: string; excluded: number; total: number }[];
};

/** The same two axes, computed within one language. */
export type LanguageSplit = {
  language: string;
  n: number;
  offset: number;
  rankAgreement: number;
};

export type HarshnessSplit = {
  level: Harshness;
  coverage: Coverage;
  /** Per-language verdicts, largest sample first. Only languages above LANGUAGE_MIN_N. */
  byLanguage: LanguageSplit[];
  /**
   * Set when two language groups disagree by more than DIVERGENCE_STARS — i.e.
   * the single global verdict is hiding something real.
   */
  divergence: { harsher: LanguageSplit; kinder: LanguageSplit; gap: number } | null;
  /** Kendall tau-b between the user's ordering and the crowd's. NaN when undefined. */
  rankAgreement: number;
  quadrant: Quadrant | null;
  /** Largest single-film rank disagreements, most extreme first. */
  disagreements: Disagreement[];
  n: number;
  /** True when there is enough data to claim a quadrant about a person. */
  quadrantTrustworthy: boolean;
};

/** Below this, show the disagreement list but not the quadrant. */
export const QUADRANT_MIN_N = 60;
/** tau-b at or above this counts as agreeing with the crowd's ordering. */
export const CONFORMIST_TAU = 0.3;

/** Crowd-comparable films needed before a per-language verdict is computed. */
export const LANGUAGE_MIN_N = 40;

/** Below this coverage share, the copy must disclose what was left out. */
export const COVERAGE_DISCLOSE_BELOW = 0.85;

/** Offset gap between languages large enough to be worth headlining, in stars. */
export const DIVERGENCE_STARS = 0.4;

/**
 * ISO 639-1 code to a readable language name.
 *
 * Uses Intl.DisplayNames rather than a hand-maintained table, which was already
 * failing: an Indonesian film rendered as "ID" in real output because `id` was
 * not in the list. ICU knows all ~180 codes, so the only entries kept here are
 * ones where the plain language name reads badly in a sentence.
 */
const LANGUAGE_OVERRIDES: Record<string, string> = {
  // "52% of what you watch is English" is ambiguous between the language and the
  // country, and the field is the language.
  en: "English-language",
  cn: "Cantonese",
  xx: "no dialogue",
};

let displayNames: Intl.DisplayNames | null = null;

export function languageName(code: string): string {
  const key = code.toLowerCase();
  const override = LANGUAGE_OVERRIDES[key];
  if (override) return override;
  if (!key || key === "??") return "an unknown language";

  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    const name = displayNames.of(key);
    // Intl returns the input unchanged when it does not recognise the code.
    if (name && name.toLowerCase() !== key) return name;
  } catch {
    // No ICU data: fall through to the code itself.
  }
  return code.toUpperCase();
}

export function harshnessSplit(ctx: StatContext): StatResult<HarshnessSplit> {
  const d = computeHarshnessSplit(ctx);

  if (d.n === 0) {
    return none(
      d,
      "None of your films have enough crowd votes to compare against — your taste runs " +
        "too far outside TMDB's well-trodden catalogue for this one to say anything honest.",
    );
  }

  if (d.quadrant) {
    const dir = d.level.offset < 0 ? "below" : "above";
    const conform = d.rankAgreement >= CONFORMIST_TAU ? "in much the same order the crowd does" : "in your own order";

    let copy =
      `You are a ${d.quadrant}. You rate ${Math.abs(d.level.offset).toFixed(2)} stars ${dir} ` +
      `expectation, and you rank films ${conform}.`;

    // Disclose what the vote-count filter cost, because it does not remove a
    // random half of a library — it removes the non-English half first.
    if (d.coverage.share < COVERAGE_DISCLOSE_BELOW) {
      const worst = d.coverage.worstExcluded[0];
      const where = worst ? ` Most of what dropped out is ${languageName(worst.language)}.` : "";
      copy +=
        ` This rests on ${d.coverage.compared} of your ${d.coverage.rated} rated films — the ones ` +
        `enough people have voted on to compare against.${where}`;
    }

    if (d.divergence) {
      copy +=
        ` And the single verdict hides a split: you are ${d.divergence.gap.toFixed(2)} stars harsher on ` +
        `${languageName(d.divergence.harsher.language)} films than on ` +
        `${languageName(d.divergence.kinder.language)} ones.`;
    }

    return strong(d, copy);
  }

  return weak(
    d,
    `Only ${d.n} of your films have enough crowd votes to compare, which is too few to call ` +
      `you harsh or contrarian — but here are the films you disagree with everyone about.`,
  );
}

function computeHarshnessSplit(ctx: StatContext): HarshnessSplit {
  const usable = ctx.rated.filter((r) => r.film.voteCount >= MIN_VOTE_COUNT && r.film.voteAverage > 0);

  // ---- coverage: what the filter cost, and where -------------------------
  const perLanguage = new Map<string, { total: number; kept: number }>();
  for (const r of ctx.rated) {
    const lang = r.film.originalLanguage || "??";
    const e = perLanguage.get(lang) ?? { total: 0, kept: 0 };
    e.total++;
    if (r.film.voteCount >= MIN_VOTE_COUNT && r.film.voteAverage > 0) e.kept++;
    perLanguage.set(lang, e);
  }
  const worstExcluded = [...perLanguage.entries()]
    .map(([language, e]) => ({ language, excluded: e.total - e.kept, total: e.total }))
    .filter((e) => e.excluded > 0)
    .sort((a, b) => b.excluded - a.excluded)
    .slice(0, 4);

  const coverage: Coverage = {
    compared: usable.length,
    rated: ctx.rated.length,
    excluded: ctx.rated.length - usable.length,
    share: ctx.rated.length === 0 ? 0 : usable.length / ctx.rated.length,
    worstExcluded,
  };

  // ---- per-language verdicts --------------------------------------------
  const groups = new Map<string, typeof usable>();
  for (const r of usable) {
    const lang = r.film.originalLanguage || "??";
    const list = groups.get(lang) ?? [];
    list.push(r);
    groups.set(lang, list);
  }

  const byLanguage: LanguageSplit[] = [];
  for (const [language, films] of groups) {
    if (films.length < LANGUAGE_MIN_N) continue;
    const h = harshness(
      films.map((r) => ({ rating: r.rating, voteAverage: r.film.voteAverage, voteCount: r.film.voteCount })),
    );
    byLanguage.push({
      language,
      n: films.length,
      offset: h.offset,
      rankAgreement: kendallTauB(films.map((r) => r.rating), films.map((r) => r.film.voteAverage)),
    });
  }
  byLanguage.sort((a, b) => b.n - a.n);

  let divergence: HarshnessSplit["divergence"] = null;
  if (byLanguage.length >= 2) {
    const sorted = [...byLanguage].sort((a, b) => a.offset - b.offset);
    const harsher = sorted[0]!;
    const kinder = sorted[sorted.length - 1]!;
    const gap = kinder.offset - harsher.offset;
    if (gap >= DIVERGENCE_STARS) divergence = { harsher, kinder, gap };
  }

  const level = harshness(
    ctx.rated.map((r) => ({
      rating: r.rating,
      voteAverage: r.film.voteAverage,
      voteCount: r.film.voteCount,
    })),
  );

  const userRatings = usable.map((r) => r.rating);
  const crowdRatings = usable.map((r) => r.film.voteAverage);
  const rankAgreement = usable.length >= 2 ? kendallTauB(userRatings, crowdRatings) : NaN;

  const userPct = percentileRanks(userRatings);
  const crowdPct = percentileRanks(crowdRatings);
  const disagreements: Disagreement[] = usable
    .map((r, i) => ({
      name: r.name,
      userRating: r.rating,
      crowdRating: r.film.voteAverage,
      rankGap: userPct[i]! - crowdPct[i]!,
      posterPath: r.film.posterPath,
    }))
    .sort((a, b) => Math.abs(b.rankGap) - Math.abs(a.rankGap))
    .slice(0, 5);

  const quadrantTrustworthy = usable.length >= QUADRANT_MIN_N && Number.isFinite(rankAgreement) && Number.isFinite(level.offset);

  let quadrant: Quadrant | null = null;
  if (quadrantTrustworthy) {
    const harshSide = level.offset < 0 ? "harsh" : "generous";
    const conformSide = rankAgreement >= CONFORMIST_TAU ? "conformist" : "contrarian";
    quadrant = `${harshSide} ${conformSide}` as Quadrant;
  }

  return {
    level, rankAgreement, quadrant, disagreements, n: usable.length, quadrantTrustworthy,
    coverage, byLanguage, divergence,
  };
}
