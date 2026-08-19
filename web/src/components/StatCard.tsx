import { useState } from "react";
import type { ComposedStat } from "../../../src/stats/compose.ts";
import { StatVisual, HAS_VISUAL } from "../viz/StatVisual.tsx";

/**
 * One stat.
 *
 * Order matters: the visual comes first, the sentence supports it, and the caveat
 * is behind a toggle. An earlier version rendered only the sentence, which made a
 * page of genuinely rich data read as a wall of text — and buried the numbers the
 * charts are built from.
 */
export function StatCard({
  stat,
  variant = "compact",
  rank,
}: {
  stat: ComposedStat;
  variant?: "feature" | "compact";
  rank?: number;
}) {
  const [showCaveat, setShowCaveat] = useState(false);
  const hasViz = HAS_VISUAL(stat.def.id) && stat.finding !== "none";

  return (
    <article className={`card card-${variant}`}>
      <div className="card-head">
        {rank ? <span className="card-rank">{String(rank).padStart(2, "0")}</span> : <span className="mark" data-f={stat.finding} aria-hidden />}
        <h3>{stat.title}</h3>
      </div>

      {hasViz ? (
        <div className="card-viz">
          <StatVisual id={stat.def.id} data={stat.result.data} />
        </div>
      ) : null}

      <p className="card-copy">{stat.copy}</p>

      {stat.def.caveat ? (
        <>
          <button type="button" className="caveat-toggle" onClick={() => setShowCaveat((v) => !v)}>
            {showCaveat ? "Hide the caveat" : "How to read this"}
          </button>
          {showCaveat ? <p className="caveat">{stat.def.caveat}</p> : null}
        </>
      ) : null}
    </article>
  );
}
