/**
 * Per-stat visuals.
 *
 * Every stat already returns a `data` object shaped for exactly one chart form —
 * a histogram, a curve, quadrant coordinates, poster paths. This module is the
 * bridge, keyed by stat id.
 *
 * The one `as` cast per entry is deliberate and contained: ComposedStat carries
 * `data: unknown` so the compose layer stays generic, and this is the single
 * boundary where each stat's own shape is re-asserted. A wrong cast here shows up
 * immediately as a blank or broken chart in dev, not as a silent wrong number.
 */
import type { ReactNode } from "react";
import { Bars, Columns, Figure, LineArea, PairedCompare } from "./Primitives.tsx";
import { DotCloud, PosterGrid, PositionScales } from "./Scatter.tsx";
import { VIZ, compact } from "./tokens.ts";

import type { ScaleCollapse } from "../../../src/stats/impl/scale-collapse.ts";
import type { HarshnessSplit } from "../../../src/stats/impl/harshness-split.ts";
import type { TasteCrystallization } from "../../../src/stats/impl/taste-crystallization.ts";
import type { TasteRadius } from "../../../src/stats/impl/taste-radius.ts";
import type { GenreConviction } from "../../../src/stats/impl/genre-conviction.ts";
import type { ComfortObject } from "../../../src/stats/impl/comfort-object.ts";
import type { ObscurityLedger } from "../../../src/stats/impl/obscurity-ledger.ts";
import type { PopularityCorrelation } from "../../../src/stats/impl/popularity-correlation.ts";
import type { CompletionistIndex } from "../../../src/stats/impl/completionist-index.ts";
import type { ImpossibleDays } from "../../../src/stats/impl/impossible-days.ts";
import type { HalfStarTell } from "../../../src/stats/impl/half-star-tell.ts";
import type { RatingSeasonality } from "../../../src/stats/impl/rating-seasonality.ts";
import type { WatchlistGraveyard } from "../../../src/stats/impl/watchlist-graveyard.ts";
import type { ReviewAsymmetry } from "../../../src/stats/impl/review-asymmetry.ts";
import type { ZeitgeistLag } from "../../../src/stats/impl/zeitgeist-lag.ts";
import type { IpShare } from "../../../src/stats/impl/ip-share.ts";
import type { Abandoned } from "../../../src/stats/impl/abandoned-discovery.ts";
import type { LanguageEntryPoints } from "../../../src/stats/impl/language-entry-points.ts";
import type { InvisibleSignature } from "../../../src/stats/impl/invisible-signature.ts";
import type { CastBlindspot } from "../../../src/stats/impl/cast-blindspot.ts";
import type { RatingBarrier } from "../../../src/stats/impl/rating-barrier.ts";
import type { RuntimePrestige } from "../../../src/stats/impl/runtime-prestige.ts";

/** A single large number. One per card at most — it is the thing being said. */
function Hero({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div className="hero-figure">
      <b>
        {value}
        {unit ? <i>{unit}</i> : null}
      </b>
      <span>{label}</span>
    </div>
  );
}

function Meters({ rows }: { rows: { label: string; done: number; total: number }[] }) {
  return (
    <ul className="meters">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="meter-label">{r.label}</span>
          <span className="meter-track">
            <i style={{ width: `${(r.done / Math.max(1, r.total)) * 100}%`, background: r.done >= r.total ? VIZ.series[0] : VIZ.series[1] }} />
          </span>
          <span className="meter-value">
            {r.done}/{r.total}
          </span>
        </li>
      ))}
    </ul>
  );
}

const STAR = (n: number) => `${n}★`;

const VISUALS: Record<string, (data: never) => ReactNode> = {
  "scale-collapse": (d: ScaleCollapse) => (
    <Figure note={`Bias-corrected entropy, 95% CI ${d.ci.lo.toFixed(2)}–${d.ci.hi.toFixed(2)} bits.`}>
      <Hero value={d.bitsUsed.toFixed(1)} unit={` / ${d.maxBits.toFixed(1)} bits`} label="of your scale in use" />
      <Columns
        data={d.histogram.map((h) => ({
          label: String(h.rating),
          value: h.count,
          emphasis: Math.abs(h.rating - d.mode) <= 0.5,
          sub: `${h.rating}★`,
        }))}
        highlightLabel={String(d.mode)}
      />
    </Figure>
  ),

  "harshness-split": (d: HarshnessSplit) => (
    <Figure note={d.quadrant ? undefined : "Quadrant withheld — too few films with comparable crowd votes."}>
      {d.quadrant ? (
        <PositionScales
          scales={[
            {
              measure: "How you rate, against what these films usually get",
              value: d.level.offset,
              domain: [-1.2, 1.2],
              poles: ["a star below", "a star above"],
              reference: 0,
              referenceLabel: "expected",
              format: (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}★`,
              verdict: d.level.offset < 0 ? "harsh" : "generous",
            },
            {
              measure: "How you order films, against the crowd's order",
              value: d.rankAgreement,
              domain: [-0.1, 0.9],
              poles: ["your own order", "the crowd's order"],
              reference: 0.3,
              referenceLabel: "conformity line",
              format: (n) => `tau ${n.toFixed(2)}`,
              verdict: d.rankAgreement >= 0.3 ? "conforms" : "contrarian",
            },
          ]}
        />
      ) : null}
      {d.byLanguage.length > 1 ? (
        <Bars
          data={d.byLanguage.map((l) => ({
            label: l.language.toUpperCase(),
            value: Math.abs(l.offset),
            color: l.offset < 0 ? VIZ.diverging.negative : VIZ.diverging.positive,
            sub: `${l.n} films, tau ${l.rankAgreement.toFixed(2)}`,
          }))}
          valueFormat={(n) => `${n.toFixed(2)}★ off`}
        />
      ) : null}
      <PosterGrid
        items={d.disagreements.map((x) => ({
          name: x.name,
          posterPath: x.posterPath,
          caption: `you ${x.userRating}★ · crowd ${x.crowdRating.toFixed(1)}`,
        }))}
        max={5}
      />
    </Figure>
  ),

  "taste-crystallization": (d: TasteCrystallization) => (
    <Figure note={`${d.binWidth}-year bins, shrunk toward your overall average so a thin era cannot spike.`}>
      <LineArea
        data={d.bins.map((b) => ({ x: b.year, y: b.shrunkMean, n: b.n, label: `${b.year}s` }))}
        yLabel="★"
        markPoint={d.peak?.year}
        xFormat={(n) => `${n}s`}
      />
      {d.peak ? <PosterGrid items={d.peak.topFilms.map((n) => ({ name: n, posterPath: null }))} max={3} /> : null}
    </Figure>
  ),

  "taste-radius": (d: TasteRadius) => {
    const langs = d.dimensions.find((x) => x.name === "languages")!;
    const countries = d.dimensions.find((x) => x.name === "countries")!;
    const decades = d.dimensions.find((x) => x.name === "decades")!;
    return (
      <Figure note="Effective count = 2^entropy: how many buckets you meaningfully use, not how many you have touched once.">
        <div className="figure-row">
          <Hero value={langs.radius.toFixed(1)} label={`languages of ${langs.touched}`} />
          <Hero value={countries.radius.toFixed(1)} label={`countries of ${countries.touched}`} />
          <Hero value={decades.radius.toFixed(1)} label={`decades of ${decades.touched}`} />
        </div>
        <Bars
          data={d.countryWeights.slice(0, 8).map((c) => ({ label: c.code, value: c.weight, sub: `${c.weight.toFixed(1)} films` }))}
          valueFormat={(n) => n.toFixed(0)}
        />
      </Figure>
    );
  },

  "genre-conviction": (d: GenreConviction) => (
    <Figure note="Right of the line means you rate that genre above your own average. Higher means less predictably.">
      <DotCloud
        data={d.genres.map((g) => ({
          x: g.lift,
          y: g.spread,
          label: g.genre,
          emphasis: g.genre === d.mostVolatile?.genre,
        }))}
        xLabel="rating lift"
        yLabel="spread"
        xZeroLine
      />
    </Figure>
  ),

  "comfort-object": (d: ComfortObject) => (
    <Figure>
      {d.top ? <PosterGrid items={[{ name: d.top.name, posterPath: d.top.posterPath, caption: `at least ${d.top.atLeastTimes} times` }]} max={1} /> : null}
      {d.seeking && d.returning ? (
        <PairedCompare
          aLabel="what you seek out"
          bLabel="what you return to"
          pairs={[
            { measure: "median release year", a: d.seeking.medianReleaseYear ?? 0, b: d.returning.medianReleaseYear ?? 0 },
            { measure: "median runtime", a: d.seeking.medianRuntime ?? 0, b: d.returning.medianRuntime ?? 0, format: (n) => `${Math.round(n)}m` },
          ]}
        />
      ) : null}
    </Figure>
  ),

  "obscurity-ledger": (d: ObscurityLedger) => (
    <Figure note={d.finds.length === 0 ? undefined : "Vote counts compared within decade-and-language cohorts, not against everything."}>
      <PosterGrid
        items={d.finds.map((f) => ({ name: f.name, posterPath: f.posterPath, caption: `${compact(f.voteCount)} votes · ${f.rating}★` }))}
        max={8}
      />
    </Figure>
  ),

  "popularity-correlation": (d: PopularityCorrelation) => (
    <Figure note={`Kendall tau-b across ${compact(d.n)} films, against cohort-normalised vote counts.`}>
      <Hero value={d.tau.toFixed(2)} label="correlation with how widely seen a film is" />
    </Figure>
  ),

  "completionist-index": (d: CompletionistIndex) => (
    <Figure note={`${d.completed.length} finished of ${d.franchises.length} entered. Unreleased sequels are never counted against you.`}>
      <Hero value={`${Math.round(d.completionRate * 100)}%`} label="of franchises you enter, you finish" />
      <Meters
        rows={[...d.franchises]
          .sort((a, b) => b.releasedParts - a.releasedParts)
          .slice(0, 8)
          .map((f) => ({ label: f.name, done: f.seen, total: f.releasedParts }))}
      />
    </Figure>
  ),

  "bulk-log-confession": (d: ImpossibleDays) => (
    <Figure note="Measured on total runtime, not film count — a festival day is real, twenty-nine hours is not.">
      <Bars
        data={[...d.impossible, ...d.marathons].slice(0, 8).map((day) => ({
          label: day.date,
          value: day.minutes / 60,
          color: day.minutes >= 20 * 60 ? VIZ.series[2] : VIZ.series[0],
          sub: `${day.films} films`,
        }))}
        valueFormat={(n) => `${n.toFixed(1)}h`}
      />
      {d.impossible.length === 0 && d.marathons.length === 0 && d.busiest ? (
        <Hero value={`${(d.busiest.minutes / 60).toFixed(1)}h`} label={`heaviest day · ${d.busiest.date}`} />
      ) : null}
    </Figure>
  ),

  "half-star-tell": (d: HalfStarTell) => (
    <Figure note="Each band is scored against the half-stars it could hold, so band width cannot fake an imbalance.">
      <Bars
        data={d.bands.map((b) => ({
          label: b.label,
          value: b.halfLift,
          color: b.halfLift >= 1 ? VIZ.diverging.positive : VIZ.diverging.negative,
          sub: `${Math.round(b.halfShare * 100)}% half-stars`,
        }))}
        valueFormat={(n) => `${n.toFixed(2)}x`}
      />
    </Figure>
  ),

  "rating-seasonality": (d: RatingSeasonality) => (
    <Figure note={d.significant ? `Survives a permutation test on the month range (p=${d.p.toFixed(3)}).` : "No month survives testing — this is what noise looks like."}>
      <Columns
        data={d.months.map((m) => ({
          label: m.label.slice(0, 1),
          value: m.shrunkMean,
          emphasis: m.month === d.best?.month,
          sub: `${m.label} · ${m.n} films`,
        }))}
        valueFormat={(n) => n.toFixed(2)}
      />
    </Figure>
  ),

  "watchlist-graveyard": (d: WatchlistGraveyard) => (
    <Figure note={`${d.unreleased.length} of ${d.total} on your watchlist are not out yet, and are not counted as neglect.`}>
      <PosterGrid
        items={d.graveyard.map((e) => ({ name: e.name, posterPath: e.posterPath, caption: `${Math.round(e.ageDays / 30)} months waiting` }))}
        max={12}
      />
    </Figure>
  ),

  "review-asymmetry": (d: ReviewAsymmetry) => (
    <Figure note={`You review ${Math.round(d.overallRate * 100)}% of what you rate.`}>
      <Bars
        data={d.bands
          .filter((b) => b.medianWords != null)
          .map((b) => ({ label: b.label, value: b.medianWords!, sub: `${b.reviews} reviews` }))}
        valueFormat={(n) => `${n} words`}
      />
    </Figure>
  ),

  "zeitgeist-lag": (d: ZeitgeistLag) => (
    <Figure note={`Of ${compact(d.n)} films watched within three years of release. ${d.catalogueExcluded} catalogue viewings excluded.`}>
      <Hero value={String(d.medianDays ?? 0)} unit=" days" label="median wait after release" />
      <Bars
        data={[
          { label: "quickest 25%", value: d.p25 ?? 0 },
          { label: "median", value: d.medianDays ?? 0 },
          { label: "slowest 25%", value: d.p75 ?? 0 },
        ]}
        valueFormat={(n) => `${Math.round(n)}d`}
      />
    </Figure>
  ),

  "ip-share": (d: IpShare) => (
    <Figure note="Trend is trustworthy; the absolute level is not — TMDB under-tags non-English series.">
      <LineArea
        data={d.years.map((y) => ({ x: y.year, y: y.share * 100, n: y.films, label: String(y.year) }))}
        yLabel="% franchise"
        yFormat={(n) => `${Math.round(n)}%`}
      />
    </Figure>
  ),

  "abandoned-discovery": (d: Abandoned[]) => (
    <Figure>
      <PosterGrid
        items={d.map((a) => ({ name: a.film, posterPath: a.posterPath, caption: `${a.director} · ${a.rating}★` }))}
        max={6}
      />
    </Figure>
  ),

  "language-entry-points": (d: LanguageEntryPoints) => (
    <Figure note="Only reliably-dated entries — a backfiller's 'first logged' is an import artefact.">
      <Bars
        data={d.entryPoints.slice(0, 8).map((e) => ({
          label: e.languageLabel,
          value: e.total,
          color: e.startedStreak ? VIZ.series[0] : VIZ.ghost,
          sub: `opened by ${e.film}`,
        }))}
        valueFormat={(n) => `${n} films`}
      />
    </Figure>
  ),

  "invisible-signature": (d: InvisibleSignature) => (
    <Figure note="Only collaborators whose films span three or more directors, so this is not your director taste in disguise.">
      <Bars
        data={d.signatures.slice(0, 5).map((s) => ({
          label: s.name,
          value: s.lift,
          sub: `${s.films} films, ${s.distinctDirectors} directors`,
        }))}
        labelWidth={150}
        valueFormat={(n) => `+${n.toFixed(2)}★`}
      />
    </Figure>
  ),

  "the-45-barrier": (d: RatingBarrier) => (
    <Figure
      note={
        d.survived
          ? `Only the winning feature was tested, against a Bonferroni threshold of ${d.threshold.toFixed(3)}.`
          : "Nothing here survived testing. These are the gaps you would see in noise."
      }
    >
      <Bars
        data={[...d.gaps]
          .sort((a, b) => Math.abs(b.standardised) - Math.abs(a.standardised))
          .map((g) => ({
            label: g.label,
            value: Math.abs(g.standardised),
            color: g.key === d.best?.key && d.survived ? VIZ.series[0] : VIZ.ghost,
            sub: `${g.rawGap > 0 ? "more" : "less"} in your ${d.upperRating}★ films`,
          }))}
        labelWidth={160}
        valueFormat={(n) => `${n.toFixed(2)} SD`}
      />
    </Figure>
  ),

  "runtime-prestige": (d: RuntimePrestige) => (
    <Figure
      note={`Difference ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(2)}, 95% CI ${d.deltaCI.lo.toFixed(2)} to ${d.deltaCI.hi.toFixed(2)}. Association, never preference.`}
    >
      <PairedCompare
        aLabel="you"
        bLabel="the crowd"
        pairs={[
          {
            measure: "runtime ↔ rating",
            a: d.userTau,
            b: d.crowdTau,
            format: (n) => `tau ${n.toFixed(2)}`,
          },
        ]}
      />
    </Figure>
  ),

  "cast-blindspot": (d: CastBlindspot) => (
    <Figure note="Top-billed roles only (billing order ≤ 8), which is where TMDB's data is least unreliable.">
      <Bars
        data={d.actors.slice(0, 8).map((a) => ({
          label: a.name,
          value: a.films,
          color: a.inTop === 0 ? VIZ.series[2] : VIZ.series[0],
          sub: `${a.inTop} in your top rated · ${a.lift >= 0 ? "+" : ""}${a.lift.toFixed(2)}★`,
        }))}
        labelWidth={150}
        valueFormat={(n) => `${n} films`}
      />
    </Figure>
  ),
};

export function StatVisual({ id, data }: { id: string; data: unknown }): ReactNode {
  const render = VISUALS[id];
  if (!render) return null;
  try {
    return render(data as never);
  } catch {
    // A visual must never take the page down. The copy still carries the finding.
    return null;
  }
}

export const HAS_VISUAL = (id: string): boolean => id in VISUALS;
