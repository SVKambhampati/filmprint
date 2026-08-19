/**
 * SVG chart primitives, with the mark specs baked in so no individual chart has to
 * remember them: bars capped at 24px with a 4px rounded data-end, 2px lines,
 * ≥8px markers carrying a 2px surface ring, hairline recessive gridlines, area
 * fills at 10%, and a 2px surface gap between touching marks.
 *
 * Every form here ships a hover layer, because an SVG chart in a page IS
 * interactive and a mark you cannot interrogate is a mark you have to guess at.
 */
import { useState, type ReactNode } from "react";
import { useWidth } from "./useWidth.ts";
import { MARK, VIZ, compact } from "./tokens.ts";

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export type Tip = { x: number; y: number; lines: string[] } | null;

/** Floating tooltip. Positioned in chart-local pixels by the caller. */
export function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width * 0.6;
  return (
    <g transform={`translate(${tip.x},${tip.y})`} pointerEvents="none">
      <g transform={`translate(${flip ? -10 : 10},0)`} textAnchor={flip ? "end" : "start"}>
        {tip.lines.map((line, i) => (
          <text
            key={i}
            y={i * 15}
            fontSize="11.5"
            fill={i === 0 ? VIZ.ink : VIZ.inkSecondary}
            style={{ paintOrder: "stroke", stroke: VIZ.surface, strokeWidth: 4, strokeLinejoin: "round" }}
          >
            {line}
          </text>
        ))}
      </g>
    </g>
  );
}

export function Figure({
  title,
  note,
  children,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <figure className="viz">
      {title ? <figcaption className="viz-title">{title}</figcaption> : null}
      {children}
      {note ? <p className="viz-note">{note}</p> : null}
    </figure>
  );
}

/** Legend. Present whenever there are two or more series — identity is never colour alone. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="viz-legend">
      {items.map((it) => (
        <span key={it.label}>
          <i style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns — magnitude across a small number of ordered categories
// ---------------------------------------------------------------------------

export type Column = { label: string; value: number; color?: string; emphasis?: boolean; sub?: string };

export function Columns({
  data,
  height = 150,
  valueFormat = compact,
  labelEvery = 1,
  highlightLabel,
}: {
  data: Column[];
  height?: number;
  valueFormat?: (n: number) => string;
  /** Show every Nth tick label, for dense axes. */
  labelEvery?: number;
  /** Direct-label just this column. Labelling every column is chaos. */
  highlightLabel?: string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [box, W] = useWidth<HTMLDivElement>();
  const padL = 4;
  const padB = 22;
  const padT = 18;
  const plotH = height - padB - padT;
  const max = Math.max(1, ...data.map((d) => d.value));
  const band = (W - padL * 2) / data.length;
  const barW = Math.min(MARK.barMaxThickness, band - MARK.surfaceGap);

  return (
    <div ref={box} className="viz-box">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="viz-svg" role="img">
      {/* Baseline only. Gridlines would out-ink the data at this size. */}
      <line x1={padL} x2={W - padL} y1={padT + plotH} y2={padT + plotH} stroke={VIZ.axis} strokeWidth="1" />
      {data.map((d, i) => {
        const h = (d.value / max) * plotH;
        const x = padL + i * band + (band - barW) / 2;
        const y = padT + plotH - h;
        const fill = d.color ?? (d.emphasis ? VIZ.series[0] : VIZ.ghost);
        return (
          <g
            key={`${d.label}-${i}`}
            onMouseEnter={() =>
              setTip({
                x: x + barW / 2,
                y: Math.max(12, y - 10),
                lines: [`${valueFormat(d.value)}`, d.sub ?? d.label],
              })
            }
            onMouseLeave={() => setTip(null)}
          >
            {/* Hit target larger than the mark. */}
            <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
            {d.value > 0 ? (
              <path
                d={roundedTop(x, y, barW, h, MARK.barRadius)}
                fill={fill}
              />
            ) : (
              <line
                x1={x}
                x2={x + barW}
                y1={padT + plotH - 1}
                y2={padT + plotH - 1}
                stroke={VIZ.ghost}
                strokeWidth="2"
              />
            )}
            {d.label === highlightLabel ? (
              <text x={x + barW / 2} y={y - 6} fontSize="11" fill={VIZ.ink} textAnchor="middle">
                {valueFormat(d.value)}
              </text>
            ) : null}
            {i % labelEvery === 0 ? (
              <text
                x={x + barW / 2}
                y={height - 7}
                fontSize="10.5"
                fill={VIZ.inkMuted}
                textAnchor="middle"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
      <Tooltip tip={tip} width={W} />
    </svg>
    </div>
  );
}

/** A bar with a 4px rounded data-end and square corners at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

// ---------------------------------------------------------------------------
// Horizontal bars — magnitude with long category names
// ---------------------------------------------------------------------------

export function Bars({
  data,
  labelWidth = 118,
  valueFormat = compact,
  rowHeight = 22,
}: {
  data: Column[];
  labelWidth?: number;
  valueFormat?: (n: number) => string;
  rowHeight?: number;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [box, W] = useWidth<HTMLDivElement>();
  const H = data.length * rowHeight + 6;
  const max = Math.max(1, ...data.map((d) => d.value));
  const barH = Math.min(MARK.barMaxThickness, rowHeight - 8);
  const plotW = W - labelWidth - 52;

  return (
    <div ref={box} className="viz-box">
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="viz-svg" role="img">
      {data.map((d, i) => {
        const w = Math.max(1, (d.value / max) * plotW);
        const y = i * rowHeight + 3;
        return (
          <g
            key={`${d.label}-${i}`}
            onMouseEnter={() => setTip({ x: labelWidth + w, y: y + barH / 2 + 4, lines: [valueFormat(d.value), d.sub ?? d.label] })}
            onMouseLeave={() => setTip(null)}
          >
            <rect x={0} y={y} width={W} height={rowHeight} fill="transparent" />
            <text x={labelWidth - 8} y={y + barH / 2 + 4} fontSize="11.5" fill={VIZ.inkSecondary} textAnchor="end">
              {d.label}
            </text>
            <path d={roundedRight(labelWidth, y, w, barH, MARK.barRadius)} fill={d.color ?? VIZ.series[0]} />
            <text
              x={labelWidth + w + 7}
              y={y + barH / 2 + 4}
              fontSize="11"
              fill={VIZ.inkMuted}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {valueFormat(d.value)}
            </text>
          </g>
        );
      })}
      <Tooltip tip={tip} width={W} />
    </svg>
    </div>
  );
}

function roundedRight(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x},${y + h} Z`;
}

// ---------------------------------------------------------------------------
// Line + area — change over an ordered continuum
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number; label?: string; n?: number };

export function LineArea({
  data,
  height = 170,
  yLabel,
  markPoint,
  xFormat = (n: number) => String(n),
  yFormat = (n: number) => n.toFixed(2),
}: {
  data: Point[];
  height?: number;
  yLabel?: string;
  /** The one point worth direct-labelling. */
  markPoint?: number;
  xFormat?: (n: number) => string;
  yFormat?: (n: number) => string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [box, W] = useWidth<HTMLDivElement>();
  const padL = 34;
  const padR = 14;
  const padT = 16;
  const padB = 24;

  const xs = data.map((d) => d.x);
  const ys = data.map((d) => d.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yPad = (Math.max(...ys) - Math.min(...ys)) * 0.18 || 0.2;
  const y0 = Math.min(...ys) - yPad;
  const y1 = Math.max(...ys) + yPad;

  const sx = (x: number) => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
  const sy = (y: number) => padT + (1 - (y - y0) / (y1 - y0 || 1)) * (height - padT - padB);

  if (data.length < 2) return null;
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${sx(d.x)},${sy(d.y)}`).join(" ");
  const area = `${path} L${sx(x1)},${sy(y0)} L${sx(x0)},${sy(y0)} Z`;
  const ticks = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15];

  return (
    <div ref={box} className="viz-box">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="viz-svg" role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={W - padR} y1={sy(t)} y2={sy(t)} stroke={VIZ.grid} strokeWidth="1" />
          <text x={padL - 6} y={sy(t) + 3.5} fontSize="10" fill={VIZ.inkMuted} textAnchor="end" style={{ fontVariantNumeric: "tabular-nums" }}>
            {yFormat(t)}
          </text>
        </g>
      ))}
      <path d={area} fill={VIZ.series[0]} opacity={MARK.areaOpacity} />
      <path d={path} fill="none" stroke={VIZ.series[0]} strokeWidth={MARK.lineWidth} strokeLinejoin="round" strokeLinecap="round" />

      {data.map((d) => (
        <g
          key={d.x}
          onMouseEnter={() =>
            setTip({
              x: sx(d.x),
              y: Math.max(14, sy(d.y) - 12),
              lines: [`${yFormat(d.y)}${yLabel ? ` ${yLabel}` : ""}`, `${d.label ?? xFormat(d.x)}${d.n != null ? ` · ${d.n} films` : ""}`],
            })
          }
          onMouseLeave={() => setTip(null)}
        >
          <circle cx={sx(d.x)} cy={sy(d.y)} r={10} fill="transparent" />
          {d.x === markPoint ? (
            <>
              <circle cx={sx(d.x)} cy={sy(d.y)} r={MARK.markerRadius + MARK.surfaceRing} fill={VIZ.surface} />
              <circle cx={sx(d.x)} cy={sy(d.y)} r={MARK.markerRadius} fill={VIZ.series[0]} />
              <text x={sx(d.x)} y={sy(d.y) - 12} fontSize="11" fill={VIZ.ink} textAnchor="middle">
                {d.label ?? xFormat(d.x)}
              </text>
            </>
          ) : null}
        </g>
      ))}

      <line x1={padL} x2={W - padR} y1={height - padB} y2={height - padB} stroke={VIZ.axis} strokeWidth="1" />
      <text x={padL} y={height - 7} fontSize="10" fill={VIZ.inkMuted}>{xFormat(x0)}</text>
      <text x={W - padR} y={height - 7} fontSize="10" fill={VIZ.inkMuted} textAnchor="end">{xFormat(x1)}</text>
      <Tooltip tip={tip} width={W} />
    </svg>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Paired comparison — two series across measures of DIFFERENT scale
// ---------------------------------------------------------------------------

export type Pair = {
  measure: string;
  a: number;
  b: number;
  format?: (n: number) => string;
};

/**
 * One row per measure, each normalised WITHIN its own row.
 *
 * This exists because the obvious alternative is wrong: median release year
 * (2025) and median runtime (147 minutes) on one shared axis is a dual-scale
 * chart in disguise — the year bars swamp everything and the runtime becomes a
 * sliver. Separate scales per row, and the numbers are labelled directly so the
 * bar only has to carry the comparison, not the value.
 */
export function PairedCompare({
  pairs,
  aLabel,
  bLabel,
}: {
  pairs: Pair[];
  aLabel: string;
  bLabel: string;
}) {
  return (
    <div className="pairs">
      <Legend items={[{ label: aLabel, color: VIZ.series[1] }, { label: bLabel, color: VIZ.series[0] }]} />
      {pairs.map((p) => {
        const fmt = p.format ?? ((n: number) => String(Math.round(n)));
        // Scale within the row, from a floor below both values, so the visible
        // difference is the difference — not the distance from zero.
        const lo = Math.min(p.a, p.b);
        const hi = Math.max(p.a, p.b);
        const span = hi - lo || 1;
        const floor = lo - span * 1.4;
        const frac = (v: number) => ((v - floor) / (hi - floor || 1)) * 100;
        return (
          <div className="pair" key={p.measure}>
            <span className="pair-measure">{p.measure}</span>
            <span className="pair-rows">
              <span className="pair-row">
                <i style={{ width: `${frac(p.a)}%`, background: VIZ.series[1] }} />
                <b>{fmt(p.a)}</b>
              </span>
              <span className="pair-row">
                <i style={{ width: `${frac(p.b)}%`, background: VIZ.series[0] }} />
                <b>{fmt(p.b)}</b>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
