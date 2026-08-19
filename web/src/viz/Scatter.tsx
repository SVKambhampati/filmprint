/**
 * Scatter forms: a positioned quadrant, a general dot cloud, and posters.
 */
import { useState } from "react";
import { useWidth } from "./useWidth.ts";
import { MARK, VIZ } from "./tokens.ts";
import { Tooltip, type Tip } from "./Primitives.tsx";

// ---------------------------------------------------------------------------
// Quadrant — where one subject sits in a 2x2 of two independent axes
// ---------------------------------------------------------------------------

export function Quadrant({
  x,
  y,
  xDomain,
  yDomain,
  xLabels,
  yLabels,
  quadrantLabel,
  xValue,
  yValue,
  height = 215,
}: {
  x: number;
  y: number;
  xDomain: [number, number];
  yDomain: [number, number];
  /** [left, right] axis poles. */
  xLabels: [string, string];
  /** [bottom, top] axis poles. */
  yLabels: [string, string];
  quadrantLabel: string;
  xValue: string;
  yValue: string;
  height?: number;
}) {
  const [box, W] = useWidth<HTMLDivElement>();
  const padX = 12;
  const padTop = 22;
  const padBottom = 30;
  const clamp = (v: number, [a, b]: [number, number]) => Math.min(b, Math.max(a, v));
  const plotW = W - padX * 2;
  const plotH = height - padTop - padBottom;
  const sx = padX + ((clamp(x, xDomain) - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotW;
  const sy = padTop + (1 - (clamp(y, yDomain) - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotH;
  const midX = padX + plotW / 2;
  const midY = padTop + plotH / 2;
  // Anchor the callout away from the nearest edge so it never leaves the frame.
  const anchor = sx > W * 0.55 ? "end" : "start";
  const calloutX = sx > W * 0.55 ? sx - 14 : sx + 14;

  return (
    <div ref={box} className="viz-box">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="viz-svg" role="img">
      <rect x={padX} y={padTop} width={plotW} height={plotH} fill="none" stroke={VIZ.grid} strokeWidth="1" />
      {/* The dividers ARE the reference lines, so they read as axes not data. */}
      <line x1={midX} x2={midX} y1={padTop} y2={height - padBottom} stroke={VIZ.axis} strokeWidth="1" />
      <line x1={padX} x2={W - padX} y1={midY} y2={midY} stroke={VIZ.axis} strokeWidth="1" />

      {/* Every label sits INSIDE the viewBox. Placing axis poles outside it meant
          they were clipped by the page edge at narrow widths. */}
      <text x={midX} y={padTop - 8} fontSize="10.5" fill={VIZ.inkMuted} textAnchor="middle">
        {yLabels[1]} ↑
      </text>
      <text x={midX} y={height - 8} fontSize="10.5" fill={VIZ.inkMuted} textAnchor="middle">
        ↓ {yLabels[0]}
      </text>
      <text x={padX + 8} y={midY - 8} fontSize="10.5" fill={VIZ.inkMuted}>
        ← {xLabels[0]}
      </text>
      <text x={W - padX - 8} y={midY - 8} fontSize="10.5" fill={VIZ.inkMuted} textAnchor="end">
        {xLabels[1]} →
      </text>

      {/* The subject. A surface ring keeps it legible where it crosses a divider. */}
      <circle cx={sx} cy={sy} r={12} fill={VIZ.series[0]} opacity={0.15} />
      <circle cx={sx} cy={sy} r={MARK.markerRadius + MARK.surfaceRing} fill={VIZ.surface} />
      <circle cx={sx} cy={sy} r={MARK.markerRadius + 1} fill={VIZ.series[0]} />

      <text x={calloutX} y={sy - 4} fontSize="13" fill={VIZ.ink} textAnchor={anchor}>
        {quadrantLabel}
      </text>
      <text x={calloutX} y={sy + 12} fontSize="10.5" fill={VIZ.inkMuted} textAnchor={anchor}>
        {xValue} · {yValue}
      </text>
    </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dot cloud — two measures across many items
// ---------------------------------------------------------------------------

export type Dot = { x: number; y: number; label: string; sub?: string; emphasis?: boolean };

export function DotCloud({
  data,
  xLabel,
  yLabel,
  height = 230,
  xZeroLine = false,
  labelled = 2,
  xFormat = (n: number) => n.toFixed(2),
  yFormat = (n: number) => n.toFixed(2),
}: {
  data: Dot[];
  xLabel: string;
  yLabel: string;
  height?: number;
  /** Draw a reference line at x = 0, for diverging measures like lift. */
  xZeroLine?: boolean;
  /** How many extremes to direct-label. Never label every point. */
  labelled?: number;
  xFormat?: (n: number) => string;
  yFormat?: (n: number) => string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const [box, W] = useWidth<HTMLDivElement>();
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 32;

  const xs = data.length > 0 ? data.map((d) => d.x) : [0, 1];
  const ys = data.length > 0 ? data.map((d) => d.y) : [0, 1];
  const xr = pad(Math.min(...xs), Math.max(...xs));
  const yr = pad(Math.min(...ys), Math.max(...ys));

  const sx = (v: number) => padL + ((v - xr[0]) / (xr[1] - xr[0])) * (W - padL - padR);
  const sy = (v: number) => padT + (1 - (v - yr[0]) / (yr[1] - yr[0])) * (height - padT - padB);

  // Label only the extremes on each axis, and only a couple of them.
  const toLabel = new Set(
    [...data].sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(0, labelled).map((d) => d.label),
  );
  for (const d of [...data].sort((a, b) => b.y - a.y).slice(0, labelled)) toLabel.add(d.label);

  return (
    <div ref={box} className="viz-box">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="viz-svg" role="img">
      <line x1={padL} x2={W - padR} y1={height - padB} y2={height - padB} stroke={VIZ.axis} strokeWidth="1" />
      <line x1={padL} x2={padL} y1={padT} y2={height - padB} stroke={VIZ.axis} strokeWidth="1" />
      {xZeroLine && xr[0] < 0 && xr[1] > 0 ? (
        <line x1={sx(0)} x2={sx(0)} y1={padT} y2={height - padB} stroke={VIZ.grid} strokeWidth="1" />
      ) : null}

      <text x={W - padR} y={height - 8} fontSize="10" fill={VIZ.inkMuted} textAnchor="end">{xLabel} →</text>
      <text x={padL} y={padT - 4} fontSize="10" fill={VIZ.inkMuted}>↑ {yLabel}</text>

      {data.map((d) => {
        const cx = sx(d.x);
        const cy = sy(d.y);
        const color = d.emphasis ? VIZ.series[0] : d.x >= 0 ? VIZ.diverging.positive : VIZ.diverging.negative;
        return (
          <g
            key={d.label}
            onMouseEnter={() => setTip({ x: cx, y: Math.max(14, cy - 12), lines: [d.label, `${xLabel} ${xFormat(d.x)} · ${yLabel} ${yFormat(d.y)}`] })}
            onMouseLeave={() => setTip(null)}
          >
            <circle cx={cx} cy={cy} r={11} fill="transparent" />
            <circle cx={cx} cy={cy} r={MARK.markerRadius + MARK.surfaceRing} fill={VIZ.surface} />
            <circle cx={cx} cy={cy} r={MARK.markerRadius} fill={color} opacity={data.length > 60 ? 0.55 : 1} />
            {toLabel.has(d.label) ? (
              <text x={cx + 9} y={cy + 3.5} fontSize="10.5" fill={VIZ.inkSecondary}>
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

function pad(lo: number, hi: number): [number, number] {
  const span = hi - lo || 1;
  return [lo - span * 0.12, hi + span * 0.12];
}

// ---------------------------------------------------------------------------
// Posters — the one form where the image IS the data
// ---------------------------------------------------------------------------

const TMDB_IMG = "https://image.tmdb.org/t/p/w185";

export type Poster = { name: string; posterPath: string | null; caption?: string };

/**
 * Poster grid.
 *
 * Images are hotlinked from TMDB's own CDN, which is what it exists for — we
 * store only the path and never rehost the bytes. Sized w185 rather than
 * original: a grid of twelve originals is several megabytes for no visible gain.
 */
export function PosterGrid({ items, max = 12 }: { items: Poster[]; max?: number }) {
  const shown = items.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <ul className="poster-grid">
      {shown.map((p, i) => (
        <li key={`${p.name}-${i}`}>
          {p.posterPath ? (
            <img src={`${TMDB_IMG}${p.posterPath}`} alt={p.name} loading="lazy" width={185} height={278} />
          ) : (
            <span className="poster-blank">{p.name}</span>
          )}
          <b>{p.name}</b>
          {p.caption ? <em>{p.caption}</em> : null}
        </li>
      ))}
    </ul>
  );
}


// ---------------------------------------------------------------------------
// Position scale — one value on a labelled continuum
// ---------------------------------------------------------------------------

export type Scale = {
  measure: string;
  value: number;
  domain: [number, number];
  /** [low pole, high pole] — what the ends of the scale MEAN. */
  poles: [string, string];
  /** Reference point, e.g. 0 for "no offset" or a conformity threshold. */
  reference?: number;
  referenceLabel?: string;
  format: (n: number) => string;
  /** Where the subject actually falls, in words. */
  verdict: string;
};

/**
 * Two numbers on labelled continua, rather than one dot in a 2x2.
 *
 * This replaced a quadrant chart. A 2x2 with a single point spends a large area
 * on four empty boxes to encode two values, and the reader still has to work out
 * what each axis means from corner labels. A position scale states the poles
 * inline, marks the reference, and puts the value where it falls — the same two
 * numbers, read instantly, in a third of the space.
 */
export function PositionScales({ scales }: { scales: Scale[] }) {
  const [box, W] = useWidth<HTMLDivElement>();
  const rowH = 66;
  const H = scales.length * rowH;
  const padX = 4;
  const trackW = W - padX * 2;

  return (
    <div ref={box} className="viz-box">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="viz-svg" role="img">
        {scales.map((sc, i) => {
          const y = i * rowH + 30;
          const clamp = (v: number) => Math.min(sc.domain[1], Math.max(sc.domain[0], v));
          const at = (v: number) => padX + ((clamp(v) - sc.domain[0]) / (sc.domain[1] - sc.domain[0])) * trackW;
          const vx = at(sc.value);
          const refX = sc.reference != null ? at(sc.reference) : null;
          return (
            <g key={sc.measure}>
              {/* Measure on the left, value on the right, one baseline. An earlier
                  version floated the value above the marker, where it collided with
                  this label whenever the marker sat mid-track. */}
              <text x={padX} y={y - 15} fontSize="10.5" fill={VIZ.inkMuted}>
                {sc.measure}
              </text>
              <text x={W - padX} y={y - 15} fontSize="12.5" fill={VIZ.ink} textAnchor="end">
                {sc.format(sc.value)} · {sc.verdict}
              </text>

              {/* Track, then the filled span from the reference to the value, so
                  the DISTANCE from normal is the thing you see. */}
              <line x1={padX} x2={W - padX} y1={y} y2={y} stroke={VIZ.grid} strokeWidth="6" strokeLinecap="round" />
              {refX != null ? (
                <>
                  <line
                    x1={Math.min(refX, vx)}
                    x2={Math.max(refX, vx)}
                    y1={y}
                    y2={y}
                    stroke={VIZ.series[0]}
                    strokeWidth="6"
                    strokeLinecap="round"
                  />
                  <line x1={refX} x2={refX} y1={y - 9} y2={y + 9} stroke={VIZ.axis} strokeWidth="1" />
                  {sc.referenceLabel ? (
                    <text x={refX} y={y + 22} fontSize="9.5" fill={VIZ.inkMuted} textAnchor="middle">
                      {sc.referenceLabel}
                    </text>
                  ) : null}
                </>
              ) : null}

              <circle cx={vx} cy={y} r={MARK.markerRadius + MARK.surfaceRing} fill={VIZ.surface} />
              <circle cx={vx} cy={y} r={MARK.markerRadius + 1} fill={VIZ.series[0]} />

              <text x={padX} y={y + 22} fontSize="9.5" fill={VIZ.inkMuted}>
                {sc.poles[0]}
              </text>
              <text x={W - padX} y={y + 22} fontSize="9.5" fill={VIZ.inkMuted} textAnchor="end">
                {sc.poles[1]}
              </text>

            </g>
          );
        })}
      </svg>
    </div>
  );
}
