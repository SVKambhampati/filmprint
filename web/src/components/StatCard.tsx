import type { ComposedStat } from "../../../src/stats/compose.ts";

/**
 * One stat. The mark colour encodes finding strength, because a page where a null
 * result looks identical to a strong one is dishonest by layout.
 */
export function StatCard({ stat, showCaveat }: { stat: ComposedStat; showCaveat?: boolean }) {
  return (
    <article className="card">
      <div className="card-head">
        <span className="mark" data-f={stat.finding} aria-hidden />
        <h3>{stat.title}</h3>
      </div>
      <p>{stat.copy}</p>
      <div className="card-meta">
        {stat.def.category.replace("-", " ")}
        {stat.finding === "none" ? " · nothing to show" : ""}
      </div>
      {showCaveat && stat.def.caveat ? <p className="caveat">{stat.def.caveat}</p> : null}
    </article>
  );
}
