/**
 * The stat registry and page selector.
 *
 * WHY THIS EXISTS
 *
 * There is no fixed set of hero stats, because there is no fixed shape of user
 * data. Logging style varies enormously: one real export had 1,868 rated films
 * against 100 diary entries (79 clean-dated) and 21 watchlist entries, which
 * gates out half of any hand-picked front page. A different user who logs every
 * watch same-day would gate out a different half.
 *
 * So the page is computed, not authored. Every stat DECLARES what sample it
 * needs; the selector checks those declarations against the actual export and
 * ranks the survivors. A stat is never responsible for deciding whether it
 * belongs on the page — that decision lives here, once.
 *
 * This has to exist before the stats themselves. Retrofitting "am I allowed to
 * render?" into 28 separate implementations is miserable; adding a stat to a
 * registry that already works is a declaration plus a pure function.
 */
import { GATES } from "../hygiene/thresholds.ts";

/**
 * Sample sizes a stat can depend on.
 *
 * Deliberately explicit rather than a generic "n": the whole point is that these
 * numbers diverge. `nRated` and `nCleanDated` differed by 24x on a real export.
 */
export type SampleMetric =
  /** Films with a current rating (ratings.csv). The widest taste sample. */
  | "nRated"
  /** Films marked watched. Wider than diary, no dates. */
  | "nWatched"
  /** Diary entries kept after hygiene. */
  | "nDiary"
  /** Diary entries safe for temporal stats: plausible lag, no bulk import, no placeholder date. */
  | "nCleanDated"
  | "nWatchlist"
  /** Watchlist films already released. The unreleased ones are a wishlist, not a backlog. */
  | "nWatchlistReleased"
  /** Diary entries flagged as rewatches. A lower bound — the flag is user-maintained. */
  | "nRewatchEntries"
  /** Films logged BOTH as a first watch and a rewatch, inside the usable rating band. */
  | "nPairedRewatch"
  | "nReviews"
  | "nTaggedEntries"
  /** Rated films whose TMDB vote_count is high enough to compare against. Needs the store. */
  | "nRatedWithCrowd"
  | "nDistinctFilms"
  /** Calendar years with enough clean-dated entries to slice. Needs the store for runtime. */
  | "nYearsWithData"
  /** TMDB collections the user has entered at least one film of. Needs the store. */
  | "nCollectionsEntered";

export type SampleProfile = Record<SampleMetric, number>;

export type Requirement = { metric: SampleMetric; min: number };

export type StatCategory =
  /** What the ratings say about taste: genres, eras, languages, crew. */
  | "taste"
  /** How the user rates: distribution shape, drift, half-star habits. */
  | "rating-behaviour"
  /** The user against the crowd. */
  | "crowd"
  /** What the user does: watchlist conversion, lag, rhythm, rewatching. */
  | "behaviour"
  /** Discovery and gaps. */
  | "discovery";

/**
 * `unflattering` stats are the ones that get shared, but a page made only of
 * them reads as an attack — the selector guarantees at least one that does not
 * sting.
 */
export type Tone = "flattering" | "neutral" | "unflattering";

export type StatDefinition = {
  id: string;
  /** User-facing name. */
  name: string;
  category: StatCategory;
  /** Does it tell the user something they did not know? 1-5. */
  revealing: 1 | 2 | 3 | 4 | 5;
  /** Would someone screenshot it? 1-5. */
  shareable: 1 | 2 | 3 | 4 | 5;
  tone: Tone;
  requires: Requirement[];
  /**
   * Set when the stat CANNOT ship yet, with the reason. Blocked stats are
   * excluded from selection regardless of sample size, so a known-wrong stat
   * cannot reach a user by accident.
   */
  blocked?: string;
  /** A caveat that must appear in the UI alongside the number. */
  caveat?: string;
};

const G = GATES;

/**
 * Every stat, with its declared requirements.
 *
 * Ratings and hazards come from the stat design spec. The requirements encode
 * the spec's gates plus the per-stat minimums it called out.
 */
export const STATS: readonly StatDefinition[] = [
  // ---- the six originally planned as heroes -------------------------------
  {
    id: "harshness-split",
    name: "Harsh or contrarian?",
    category: "crowd",
    revealing: 5,
    shareable: 5,
    tone: "unflattering",
    requires: [{ metric: "nRatedWithCrowd", min: G.crowdComparison }],
    caveat:
      "The harshness axis uses a provisional calibration curve, not a fitted one. " +
      "Report the quadrant, never a precise number of stars. TMDB vote counts are " +
      "English-biased, so this rests on the better-known part of a library — the " +
      "stat discloses its own coverage and splits by language when they disagree.",
  },
  {
    id: "taste-crystallization",
    name: "When your taste formed",
    category: "taste",
    revealing: 5,
    shareable: 5,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.ratingDistribution }],
    caveat:
      "Films from your teens are self-selected and heavily rewatched, so this is " +
      "the era of films you chose to log and rate highly — not quality by era.",
  },
  {
    id: "watchlist-graveyard",
    name: "Your watchlist graveyard",
    category: "behaviour",
    revealing: 4,
    shareable: 5,
    tone: "unflattering",
    // Only released films. An unreleased film on a watchlist is a wishlist entry,
    // not a backlog entry, and counting it as neglect is simply wrong.
    requires: [{ metric: "nWatchlistReleased", min: 10 }],
    caveat:
      "This is an AGE list, not a conversion rate. Letterboxd removes a film from " +
      "your watchlist when you log it, and the export holds only the current " +
      "watchlist, so a film that went from watchlist to watched leaves no trace of " +
      "when it was added. Time-to-watch and conversion rate are not computable " +
      "from one export -- verified against a real one: zero overlap between " +
      "watchlist and watched. Films added and then deleted unwatched are also " +
      "invisible, so a purger's list looks healthier than it was.",
  },
  {
    id: "invisible-signature",
    name: "Your invisible signature",
    category: "taste",
    revealing: 5,
    shareable: 4,
    tone: "flattering",
    requires: [{ metric: "nRated", min: G.perPerson }],
    caveat:
      "A crew member only qualifies if their films span 3+ distinct directors, so " +
      "the signal cannot be carried by one working relationship — otherwise this is " +
      "a director stat with a fancier job title (Deakins looks like your favourite " +
      "DoP because you like Villeneuve). Keyword themes are filtered through a " +
      "blocklist, or every user's recurring theme is 'aftercreditsstinger'. TMDB " +
      "keyword coverage is thin for non-English and pre-1980 films, so a theme is " +
      "partly a measure of which films have good metadata.",
  },
  {
    id: "scale-collapse",
    name: "Your scale has collapsed",
    category: "rating-behaviour",
    revealing: 5,
    shareable: 4,
    tone: "unflattering",
    requires: [{ metric: "nRated", min: G.ratingDistribution }],
  },
  {
    id: "taste-radius",
    name: "Taste radius",
    category: "taste",
    revealing: 4,
    shareable: 5,
    tone: "unflattering",
    requires: [{ metric: "nDistinctFilms", min: G.ratingDistribution }],
    caveat: "original_language is a language, not a nationality: a US film shot in Spain is 'en'.",
  },

  // ---- secondary ----------------------------------------------------------
  {
    id: "abandoned-discovery",
    name: "Abandoned discoveries",
    category: "discovery",
    revealing: 5,
    shareable: 4,
    tone: "neutral",
    // Works BETTER at low n: a light logger has many abandoned discoveries.
    requires: [{ metric: "nRated", min: 20 }],
  },
  {
    id: "one-and-done",
    name: "One-and-done directors",
    category: "discovery",
    revealing: 5,
    shareable: 3,
    tone: "unflattering",
    requires: [{ metric: "nRated", min: G.perPerson }],
    blocked:
      "The raw share is a library-size proxy wearing a personality-insight costume: " +
      "at 40 films almost everyone is one-and-done. Reporting it honestly needs a " +
      "deviation from a null built on how films are actually distributed across " +
      "directors, and that reference distribution is a separate dataset build " +
      "(TMDB person credits for every director in the library). Until it exists " +
      "this stat can only mislead.",
  },
  {
    id: "the-45-barrier",
    name: "What separates your top two ratings",
    category: "rating-behaviour",
    revealing: 4,
    shareable: 4,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.perPerson }],
    caveat:
      "A fishing expedition by design. The winning gap must survive a permutation " +
      "test at a Bonferroni-adjusted threshold; if nothing does, say so — 'the " +
      "difference is mood' is the better line. Compares the top two POPULATED " +
      "rating values rather than hardcoding 5 vs 4.5, because a user with no 5s " +
      "would otherwise never see this at all.",
  },
  {
    id: "rewatch-delta",
    name: "First watch vs rewatch",
    category: "behaviour",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nPairedRewatch", min: 15 }],
    caveat:
      "Ceiling effects mean a 5-star film can only move down. Headline only the " +
      "2.5-4.0 band, where movement is possible in both directions.",
  },
  {
    id: "comfort-object",
    name: "Your comfort object",
    category: "behaviour",
    revealing: 4,
    shareable: 5,
    tone: "unflattering",
    requires: [{ metric: "nRewatchEntries", min: 10 }],
    caveat: "The rewatch flag is user-maintained, so counts are lower bounds. Say 'at least'.",
  },
  {
    id: "ip-share",
    name: "How much of what you watch is IP",
    category: "taste",
    revealing: 4,
    shareable: 5,
    tone: "unflattering",
    requires: [{ metric: "nYearsWithData", min: 2 }],
    caveat:
      "belongs_to_collection under-tags non-English series, so the absolute level is " +
      "unreliable. Show the within-user trend, downplay the level.",
  },
  {
    id: "bulk-log-confession",
    name: "Your impossible days",
    category: "behaviour",
    revealing: 3,
    shareable: 5,
    tone: "unflattering",
    // Robust at any n, which makes it a good stat for light loggers.
    requires: [{ metric: "nDiary", min: 1 }],
    caveat: "Test on total runtime, not film count — a festival day is real. Keep the tone playful.",
  },
  {
    id: "genre-conviction",
    name: "Where you're certain, where you gamble",
    category: "taste",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.ratingDistribution }],
    caveat:
      "You only watch horror you expect to like, so this measures how well you PICK " +
      "within a genre, not how much you like it. Label it that way.",
  },
  {
    id: "log-lag",
    name: "How fast you log what you loved",
    category: "behaviour",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nCleanDated", min: G.cleanDated }],
    caveat: "Zero-inflated: report P(same day) by rating band, then lag given not-same-day.",
  },
  {
    id: "obscurity-ledger",
    name: "Your best obscure finds",
    category: "discovery",
    revealing: 4,
    shareable: 5,
    tone: "flattering",
    requires: [{ metric: "nRatedWithCrowd", min: G.crowdComparison }],
    caveat:
      "vote_count is recency- and English-biased. Normalise within release-year x " +
      "language cohorts or this degenerates into 'you watch old foreign films'.",
  },
  {
    id: "zeitgeist-lag",
    name: "First-week or two-years-later",
    category: "behaviour",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nCleanDated", min: 30 }],
    caveat: "TMDB's release_date is often the US or festival date, inflating lag for non-US users.",
  },
  {
    id: "runtime-prestige",
    name: "Do you reward length?",
    category: "crowd",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nRatedWithCrowd", min: 100 }],
    caveat: "Association, never preference. r is typically 0.1-0.2 and unstable; show the CI.",
  },
  {
    id: "review-asymmetry",
    name: "What makes you write",
    category: "rating-behaviour",
    revealing: 4,
    shareable: 3,
    tone: "neutral",
    requires: [{ metric: "nReviews", min: 25 }],
    caveat: "Report review RATE and review LENGTH separately; length is conditional on reviewing.",
  },
  {
    id: "language-entry-points",
    name: "What opened a language for you",
    category: "discovery",
    revealing: 4,
    shareable: 3,
    tone: "flattering",
    requires: [{ metric: "nDiary", min: 20 }],
    caveat: "'First logged' is not 'first watched' for backfillers. Use the clean-dated subset.",
  },
  {
    id: "drought-and-binge",
    name: "Your logging rhythm",
    category: "behaviour",
    revealing: 3,
    shareable: 4,
    tone: "neutral",
    requires: [{ metric: "nCleanDated", min: G.cleanDated }],
    caveat:
      "This measures LOGGING, not watching. A year you stopped using the app looks " +
      "like a year you stopped watching films. Label it 'logging rhythm'.",
  },
  {
    id: "popularity-correlation",
    name: "You like what everyone likes",
    category: "crowd",
    revealing: 5,
    shareable: 3,
    tone: "unflattering",
    requires: [{ metric: "nRatedWithCrowd", min: G.crowdComparison }],
    caveat: "Use vote_count, not popularity — popularity changes weekly and will not reproduce.",
  },
  {
    id: "studio-capture",
    name: "Your defining studio",
    category: "taste",
    revealing: 3,
    shareable: 5,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.perPerson }],
    blocked:
      "production_companies is a messy list of shells and co-financiers. Without a " +
      "curated allow-list this proudly tells users their defining studio is Village " +
      "Roadshow Pictures. Build last.",
  },
  {
    id: "private-vocabulary",
    name: "Your private vocabulary",
    category: "taste",
    revealing: 4,
    shareable: 3,
    tone: "flattering",
    requires: [{ metric: "nTaggedEntries", min: 10 }],
  },
  {
    id: "half-star-tell",
    name: "The half-star tell",
    category: "rating-behaviour",
    revealing: 3,
    shareable: 4,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.ratingDistribution }],
  },
  {
    id: "cast-blindspot",
    name: "The actor you keep watching but never love",
    category: "taste",
    revealing: 3,
    shareable: 4,
    tone: "neutral",
    requires: [{ metric: "nRated", min: G.perPerson }],
    caveat: "TMDB billing order is unreliable for older and non-English films. Cap at order <= 8.",
  },
  {
    id: "completionist-index",
    name: "Franchises you abandon",
    category: "behaviour",
    revealing: 3,
    shareable: 3,
    tone: "unflattering",
    requires: [{ metric: "nCollectionsEntered", min: 5 }],
    caveat: "Cap the denominator at RELEASED films or users get penalised for unreleased sequels.",
  },
  {
    id: "rating-seasonality",
    name: "Your best and worst months",
    category: "rating-behaviour",
    revealing: 3,
    shareable: 4,
    tone: "neutral",
    requires: [{ metric: "nCleanDated", min: G.temporalSlicing }],
    caveat:
      "Renders a finding ONLY when a permutation test on the month range clears " +
      "p < 0.05, because the maximum of twelve noisy monthly means is a biased " +
      "estimator by construction. Expect it to report no seasonality for most " +
      "users — that is the honest answer, not a failure. Runs on the clean-dated " +
      "subset only, since backfilled dates would manufacture a January spike.",
  },
];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type MissingRequirement = Requirement & { have: number };

export type StatVerdict =
  | { def: StatDefinition; status: "available"; score: number; headroom: number }
  | { def: StatDefinition; status: "gated"; missing: MissingRequirement[] }
  | { def: StatDefinition; status: "blocked"; reason: string };

export type Selection = {
  hero: StatDefinition[];
  secondary: StatDefinition[];
  gated: Extract<StatVerdict, { status: "gated" }>[];
  blocked: Extract<StatVerdict, { status: "blocked" }>[];
  /** All verdicts, ranked. Useful for debugging why a page looks the way it does. */
  verdicts: StatVerdict[];
};

/**
 * How comfortably a stat clears its gates, 0-1.
 *
 * A stat scraping past its minimum is worth less than one with ten times the
 * data it needs, even at equal revealing/shareable — so headroom modulates the
 * ranking without dominating it.
 */
export function headroomOf(def: StatDefinition, profile: SampleProfile): number {
  if (def.requires.length === 0) return 1;
  let worst = Infinity;
  for (const r of def.requires) {
    const have = profile[r.metric] ?? 0;
    worst = Math.min(worst, r.min === 0 ? 1 : have / r.min);
  }
  return Math.min(worst, 3) / 3;
}

export function scoreOf(def: StatDefinition, profile: SampleProfile): number {
  const base = def.revealing * def.shareable;
  return base * (0.6 + 0.4 * headroomOf(def, profile));
}

export function judge(def: StatDefinition, profile: SampleProfile): StatVerdict {
  if (def.blocked) return { def, status: "blocked", reason: def.blocked };

  const missing: MissingRequirement[] = [];
  for (const r of def.requires) {
    const have = profile[r.metric] ?? 0;
    if (have < r.min) missing.push({ ...r, have });
  }
  if (missing.length > 0) return { def, status: "gated", missing };

  return { def, status: "available", score: scoreOf(def, profile), headroom: headroomOf(def, profile) };
}

export type SelectOptions = {
  heroCount?: number;
  /**
   * Cap per category in the hero row. Six variations on "the shape of your
   * rating distribution" is a repetitive page even if each one clears its gate.
   */
  maxPerCategory?: number;
};

/**
 * Build the page for one user.
 *
 * Greedy by score, subject to two constraints that exist for editorial rather
 * than statistical reasons:
 *   - category diversity, so the hero row is not six versions of one idea;
 *   - at least one stat that does not sting, because a page made entirely of
 *     unflattering findings reads as an attack rather than a mirror.
 */
export function selectStats(
  profile: SampleProfile,
  defs: readonly StatDefinition[] = STATS,
  { heroCount = 6, maxPerCategory = 2 }: SelectOptions = {},
): Selection {
  const verdicts = defs.map((d) => judge(d, profile));

  const available = verdicts
    .filter((v): v is Extract<StatVerdict, { status: "available" }> => v.status === "available")
    .sort((a, b) => b.score - a.score || a.def.id.localeCompare(b.def.id));

  const hero: StatDefinition[] = [];
  const perCategory = new Map<StatCategory, number>();
  const rest: StatDefinition[] = [];

  for (const v of available) {
    const used = perCategory.get(v.def.category) ?? 0;
    if (hero.length < heroCount && used < maxPerCategory) {
      hero.push(v.def);
      perCategory.set(v.def.category, used + 1);
    } else {
      rest.push(v.def);
    }
  }

  // Guarantee the page is not purely an attack.
  if (hero.length > 0 && hero.every((d) => d.tone === "unflattering")) {
    const relief = rest.find((d) => d.tone !== "unflattering");
    if (relief) {
      const dropped = hero.pop()!;
      hero.push(relief);
      rest.splice(rest.indexOf(relief), 1);
      rest.unshift(dropped);
    }
  }

  return {
    hero,
    secondary: rest,
    gated: verdicts.filter((v): v is Extract<StatVerdict, { status: "gated" }> => v.status === "gated"),
    blocked: verdicts.filter((v): v is Extract<StatVerdict, { status: "blocked" }> => v.status === "blocked"),
    verdicts,
  };
}
