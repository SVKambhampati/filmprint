/**
 * The result contract every stat returns.
 *
 * Two ideas are encoded in the type rather than left to discipline:
 *
 * 1. A stat SELF-ASSESSES its finding strength. Only the stat can know this. The
 *    selector cannot tell that a 0.14-star gap between a user's best and
 *    second-best era is inside the noise — taste-crystallization already
 *    computed exactly that, and before this contract existed it threw the
 *    judgment away.
 *
 * 2. Every stat must produce a SENTENCE, in both branches of the union. A stat
 *    that computed a null result still has something to say ("nothing you rate
 *    highly is obscure" is a real observation about a person), and making the
 *    string non-optional means a blank card cannot ship by accident. Same trick
 *    as `blocked` in the registry: make the honest path the only one that
 *    compiles.
 *
 * The rule this exists to serve: DEMOTE, NEVER HIDE. A null result loses its
 * slot in the hero row, not its place on the page.
 */

export type Finding = "strong" | "weak" | "none";

/** Matches registry.Tone. Duplicated to keep this module free of registry imports. */
export type ResultTone = "flattering" | "neutral" | "unflattering";

/**
 * Overrides a stat may apply to its own presentation.
 *
 * A registry entry names a stat by its EXPECTED conclusion ("Your scale has
 * collapsed"), which is wrong whenever the finding inverts — that title over copy
 * reading "you actually use your scale" is a contradiction the user will notice
 * immediately. Same for tone: a stat catalogued as unflattering can return good
 * news, and the page should not then hunt for a relief slot it already has.
 */
export type Framing = {
  /** Replaces the registry's name for this user. */
  title?: string;
  /** Replaces the registry's tone for this user. */
  tone?: ResultTone;
};

export type StatResult<T> =
  | (Framing & {
      data: T;
      finding: "strong" | "weak";
      /** The user-facing sentence. Required — a number without a claim is not a stat. */
      headline: string;
    })
  | (Framing & {
      data: T;
      finding: "none";
      /** Why there is nothing to show, phrased as the finding it actually is. */
      emptyCopy: string;
    });

/** Ordering weight for sorting. Higher is better. */
export const FINDING_RANK: Record<Finding, number> = { strong: 2, weak: 1, none: 0 };

export function copyOf<T>(r: StatResult<T>): string {
  return r.finding === "none" ? r.emptyCopy : r.headline;
}

export function strong<T>(data: T, headline: string, framing: Framing = {}): StatResult<T> {
  return { data, finding: "strong", headline, ...framing };
}
export function weak<T>(data: T, headline: string, framing: Framing = {}): StatResult<T> {
  return { data, finding: "weak", headline, ...framing };
}
export function none<T>(data: T, emptyCopy: string, framing: Framing = {}): StatResult<T> {
  return { data, finding: "none", emptyCopy, ...framing };
}
