import type { Page } from "../../../src/stats/compose.ts";

/**
 * Everything the page decided not to show, and why.
 *
 * Collapsed rather than hidden. A user who wonders why they did not get a stat
 * their friend got deserves an answer, and "you have 21 watchlist films, this
 * needs 25" is a better answer than silence.
 */
export function Withheld({ page }: { page: Page }) {
  const total = page.gated.length + page.blocked.length + page.unimplemented.length;
  if (total === 0) return null;

  return (
    <details className="withheld">
      <summary>{total} stats not shown — why</summary>
      <table>
        <tbody>
          {page.gated.map((g) => (
            <tr key={g.def.id}>
              <td>{g.def.name}</td>
              <td>
                needs{" "}
                {g.missing
                  .map((m) => `${m.min} ${labelFor(m.metric)} (you have ${m.have})`)
                  .join(", ")}
              </td>
            </tr>
          ))}
          {page.blocked.map((b) => (
            <tr key={b.def.id}>
              <td>{b.def.name}</td>
              <td>not shipped yet — {b.reason.split(".")[0]}.</td>
            </tr>
          ))}
          {page.unimplemented.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>not built yet</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const LABELS: Record<string, string> = {
  nRated: "rated films",
  nWatched: "watched films",
  nDiary: "diary entries",
  nCleanDated: "reliably dated entries",
  nWatchlist: "watchlist films",
  nWatchlistReleased: "released watchlist films",
  nRewatchEntries: "logged rewatches",
  nPairedRewatch: "films watched and rewatched",
  nReviews: "reviews",
  nTaggedEntries: "tagged entries",
  nRatedWithCrowd: "films with comparable crowd votes",
  nDistinctFilms: "distinct films",
  nYearsWithData: "years of data",
  nCollectionsEntered: "franchises entered",
};

function labelFor(metric: string): string {
  return LABELS[metric] ?? metric;
}
