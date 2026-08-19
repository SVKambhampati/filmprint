/**
 * Chart tokens for filmprint's dark surface.
 *
 * The categorical slots are VALIDATED, not chosen by eye:
 *   node scripts/validate_palette.js "#c98500,#3987e5,#d55181" --mode dark \
 *     --surface "#171615" --pairs all
 *   → all checks pass. Worst all-pairs CVD ΔE 8.7 (tritan), normal-vision 19.3,
 *     all three inside the dark lightness band and ≥3:1 on the card surface.
 *
 * Note the brand gold (#d8a24a) is deliberately NOT a data color: it measures
 * L 0.747, outside the dark band, and failed validation. It stays on chrome —
 * the logo, links, section rules — while data marks use the darker amber step.
 * A brand color earns its way onto a chart or it doesn't get on.
 */

export const VIZ = {
  surface: "#171615",
  ink: "#f2efe9",
  inkSecondary: "#c3c2b7",
  inkMuted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",

  /** Categorical slots, in fixed order. Never cycled — a 4th series folds to Other. */
  series: ["#c98500", "#3987e5", "#d55181"] as const,

  /** Diverging: warm/cool poles with a neutral midpoint, for lift around zero. */
  diverging: { positive: "#c98500", midpoint: "#383835", negative: "#3987e5" },

  /** Sequential amber, low→high, for magnitude (heatmap cells, map fills). */
  sequential: ["#241f16", "#3f3319", "#5d481a", "#7d5f16", "#9d720b", "#c98500"] as const,

  /** De-emphasised mark, for context data that is not the point of the chart. */
  ghost: "#2a2724",
} as const;

/** Mark specs from the method — fixed across every chart here. */
export const MARK = {
  barMaxThickness: 24,
  barRadius: 4,
  lineWidth: 2,
  markerRadius: 4.5,
  /** Ring and gap are drawn in the surface colour, never as a stroke on the mark. */
  surfaceRing: 2,
  surfaceGap: 2,
  areaOpacity: 0.1,
} as const;

/** Pick a sequential step for a 0..1 magnitude. */
export function seqStep(t: number): string {
  const steps = VIZ.sequential;
  if (!Number.isFinite(t)) return VIZ.ghost;
  const i = Math.min(steps.length - 1, Math.max(0, Math.round(t * (steps.length - 1))));
  return steps[i]!;
}

/** Compact number formatting for labels: 1,284 / 12.9K / 1.2M. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}
