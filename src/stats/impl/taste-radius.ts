/**
 * H6 — "Taste radius."
 *
 * Effective number of categories (2^H) over language, country and decade. A user
 * with counts [50, 50] has a radius of 2.0; [98, 1, 1] has ~1.2. It answers "how
 * many buckets do you MEANINGFULLY use", not "how many have you touched once".
 *
 * Entropy is bias-corrected, because the plug-in estimator understates it at
 * small n and would tell every light logger their taste is narrow — a fact about
 * sample size, not the person.
 */
import type { StatContext } from "../context.ts";
import { effectiveCategories } from "../primitives.ts";
import { decadeOf, releaseYearOf } from "../util.ts";
import { languageName } from "./harshness-split.ts";
import { none, strong, weak, type StatResult } from "../result.ts";

export type Dimension = {
  name: "languages" | "countries" | "decades";
  /** Effective number of categories. */
  radius: number;
  /** Distinct categories touched at all. */
  touched: number;
  /** The largest bucket and its share. */
  dominant: { label: string; share: number } | null;
};

export type TasteRadius = {
  dimensions: Dimension[];
  /** Weighted country counts, for a map. Weights are fractional. */
  countryWeights: { code: string; weight: number }[];
  n: number;
};

/** Below this effective radius on languages, taste reads as narrow. */
export const NARROW_LANGUAGE_RADIUS = 2.0;

export function tasteRadius(ctx: StatContext): StatResult<TasteRadius> {
  const d = computeTasteRadius(ctx);
  if (d.n === 0) return none(d, "You have not rated any films we could resolve, so there is no radius to measure.");

  const langs = d.dimensions.find((x) => x.name === "languages")!;
  const decades = d.dimensions.find((x) => x.name === "decades")!;
  const dom = langs.dominant;

  if (langs.radius < NARROW_LANGUAGE_RADIUS && dom) {
    return strong(
      d,
      `Your taste has an effective range of ${langs.radius.toFixed(1)} languages and ` +
        `${decades.radius.toFixed(1)} decades. You have touched ${langs.touched} languages, but ` +
        `${Math.round(dom.share * 100)}% of what you watch is ${languageName(dom.label)} — the rest ` +
        `barely registers.`,
      { title: "Your taste has a small radius", tone: "unflattering" },
    );
  }

  return strong(
    d,
    `Your taste spans ${langs.radius.toFixed(1)} effective languages and ${decades.radius.toFixed(1)} ` +
      `decades across ${langs.touched} languages in total` +
      (dom ? `, led by ${languageName(dom.label)} at ${Math.round(dom.share * 100)}%` : "") +
      `. That is a genuinely wide range.`,
    { title: "Your taste has a wide radius", tone: "flattering" },
  );
}

function computeTasteRadius(ctx: StatContext): TasteRadius {
  const langWeights = new Map<string, number>();
  const countryWeights = new Map<string, number>();
  const decadeWeights = new Map<string, number>();

  for (const r of ctx.rated) {
    const lang = r.film.originalLanguage || "??";
    langWeights.set(lang, (langWeights.get(lang) ?? 0) + 1);

    // Fractional: a co-production contributes a share to each country, so the
    // totals still sum to the film count.
    for (const c of ctx.countries.get(r.film.tmdbId) ?? []) {
      countryWeights.set(c.code, (countryWeights.get(c.code) ?? 0) + c.weight);
    }

    const y = releaseYearOf(r.film.releaseDate);
    if (y != null) {
      const dec = String(decadeOf(y));
      decadeWeights.set(dec, (decadeWeights.get(dec) ?? 0) + 1);
    }
  }

  const dim = (name: Dimension["name"], weights: Map<string, number>): Dimension => {
    const entries = [...weights.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, w]) => a + w, 0);
    const top = entries[0];
    return {
      name,
      radius: effectiveCategories(entries.map(([, w]) => w)),
      touched: entries.length,
      dominant: top && total > 0 ? { label: top[0], share: top[1] / total } : null,
    };
  };

  return {
    dimensions: [dim("languages", langWeights), dim("countries", countryWeights), dim("decades", decadeWeights)],
    countryWeights: [...countryWeights.entries()]
      .map(([code, weight]) => ({ code, weight }))
      .sort((a, b) => b.weight - a.weight),
    n: ctx.rated.length,
  };
}
