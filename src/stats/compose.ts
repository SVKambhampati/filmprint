/**
 * Wiring stat declarations to stat implementations, and composing a page.
 *
 * Kept separate from the registry so the registry stays a pure declaration with
 * no import of any implementation — otherwise every stat pulls in the registry
 * that describes it, and the cycle makes both untestable.
 *
 * Ordering rule: FINDING STRENGTH FIRST, editorial score as a tiebreaker within
 * a tier. A stat that clears its sample gate can still have nothing to say, and
 * the selector cannot know that without asking. Null results are demoted, never
 * hidden — they still carry a sentence worth reading.
 */
import type { StatContext } from "./context.ts";
import { judge, scoreOf, type SampleProfile, type StatDefinition, STATS } from "./registry.ts";
import { FINDING_RANK, copyOf, type Finding, type StatResult } from "./result.ts";
import { scaleCollapse } from "./impl/scale-collapse.ts";
import { harshnessSplit } from "./impl/harshness-split.ts";
import { tasteCrystallization } from "./impl/taste-crystallization.ts";
import { comfortObject } from "./impl/comfort-object.ts";
import { obscurityLedger } from "./impl/obscurity-ledger.ts";
import { abandonedDiscovery } from "./impl/abandoned-discovery.ts";

export type Computable = (ctx: StatContext) => StatResult<unknown>;

/**
 * Stat id -> implementation. A registry entry without an entry here is declared
 * but not built yet, and is reported as such rather than silently skipped.
 */
export const IMPLEMENTATIONS: Readonly<Record<string, Computable>> = {
  "scale-collapse": scaleCollapse,
  "harshness-split": harshnessSplit,
  "taste-crystallization": tasteCrystallization,
  "comfort-object": comfortObject,
  "obscurity-ledger": obscurityLedger,
  "abandoned-discovery": abandonedDiscovery,
};

export type ComposedStat = {
  def: StatDefinition;
  result: StatResult<unknown>;
  finding: Finding;
  /** The title to render: the stat's own override if it corrected itself. */
  title: string;
  /** The tone to act on: likewise. */
  tone: StatDefinition["tone"];
  copy: string;
  score: number;
};

export type Page = {
  hero: ComposedStat[];
  secondary: ComposedStat[];
  /** Declared, gated out by sample size. */
  gated: { def: StatDefinition; missing: { metric: string; min: number; have: number }[] }[];
  /** Declared, blocked pending a fix. */
  blocked: { def: StatDefinition; reason: string }[];
  /** Declared and ungated, but no implementation exists yet. */
  unimplemented: StatDefinition[];
};

export function composePage(
  ctx: StatContext,
  profile: SampleProfile = ctx.profile,
  { heroCount = 6, maxPerCategory = 2, defs = STATS }: { heroCount?: number; maxPerCategory?: number; defs?: readonly StatDefinition[] } = {},
): Page {
  const computed: ComposedStat[] = [];
  const gated: Page["gated"] = [];
  const blocked: Page["blocked"] = [];
  const unimplemented: StatDefinition[] = [];

  for (const def of defs) {
    const verdict = judge(def, profile);
    if (verdict.status === "blocked") {
      blocked.push({ def, reason: verdict.reason });
      continue;
    }
    if (verdict.status === "gated") {
      gated.push({ def, missing: verdict.missing });
      continue;
    }
    const impl = IMPLEMENTATIONS[def.id];
    if (!impl) {
      unimplemented.push(def);
      continue;
    }
    const result = impl(ctx);
    computed.push({
      def,
      result,
      finding: result.finding,
      // A stat may override the registry's name and tone when its finding
      // inverts the expected conclusion.
      title: result.title ?? def.name,
      tone: result.tone ?? def.tone,
      copy: copyOf(result),
      score: scoreOf(def, profile),
    });
  }

  // Finding strength dominates; editorial score breaks ties inside a tier.
  computed.sort(
    (a, b) =>
      FINDING_RANK[b.finding] - FINDING_RANK[a.finding] ||
      b.score - a.score ||
      a.def.id.localeCompare(b.def.id),
  );

  const hero: ComposedStat[] = [];
  const secondary: ComposedStat[] = [];
  const perCategory = new Map<string, number>();

  for (const c of computed) {
    const used = perCategory.get(c.def.category) ?? 0;
    // A null result never takes a hero slot, however good the stat is on paper.
    const eligible = c.finding !== "none" && hero.length < heroCount && used < maxPerCategory;
    if (eligible) {
      hero.push(c);
      perCategory.set(c.def.category, used + 1);
    } else {
      secondary.push(c);
    }
  }

  // Keep the page from being purely unflattering.
  if (hero.length > 0 && hero.every((c) => c.tone === "unflattering")) {
    const relief = secondary.find((c) => c.tone !== "unflattering" && c.finding !== "none");
    if (relief) {
      const dropped = hero.pop()!;
      hero.push(relief);
      secondary.splice(secondary.indexOf(relief), 1);
      secondary.unshift(dropped);
    }
  }

  return { hero, secondary, gated, blocked, unimplemented };
}
