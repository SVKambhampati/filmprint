import { useCallback, useEffect, useRef, useState } from "react";
import { analyze, readDrop, type Analysis } from "./lib/analyze.ts";
import { StatCard } from "./components/StatCard.tsx";
import { Withheld } from "./components/Withheld.tsx";

type State =
  | { kind: "idle" }
  | { kind: "working"; note: string }
  | { kind: "done"; analysis: Analysis }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const runFiles = useCallback(async (parsed: Awaited<ReturnType<typeof readDrop>>) => {
    setState({ kind: "working", note: "Looking up films" });
    const analysis = await analyze(parsed);
    setState({ kind: "done", analysis });
  }, []);

  /**
   * Dev affordance: `?demo` loads CSVs from web/public/demo so the layout can be
   * iterated on without dragging a file every reload. That directory is
   * gitignored — it holds a real person's viewing history.
   */
  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("demo")) return;
    void (async () => {
      try {
        setState({ kind: "working", note: "Loading demo export" });
        const names = ["diary", "ratings", "watched", "watchlist", "reviews"] as const;
        const parsed: Record<string, string> = {};
        for (const n of names) {
          const res = await fetch(`/demo/${n}.csv`);
          if (res.ok) parsed[n] = await res.text();
        }
        await runFiles(parsed);
      } catch (err) {
        setState({ kind: "error", message: (err as Error).message });
      }
    })();
  }, [runFiles]);

  const run = useCallback(async (files: File[]) => {
    try {
      setState({ kind: "working", note: "Reading your export" });
      const parsed = await readDrop(files);
      if (Object.keys(parsed).length === 0) {
        throw new Error(
          "That didn't contain any Letterboxd CSVs. Drop the zip you downloaded, or the ratings.csv inside it.",
        );
      }
      setState({ kind: "working", note: "Looking up films" });
      const analysis = await analyze(parsed);
      setState({ kind: "done", analysis });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, []);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1 className="logo">
          film<em>print</em>
        </h1>
        <p className="tagline">
          Letterboxd counts what you watched. This is about what it says about you.
        </p>
        <p className="privacy">Your ratings never leave this browser</p>
      </header>

      {state.kind === "idle" || state.kind === "error" ? (
        <>
          <button
            type="button"
            className="drop"
            data-over={over}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void run([...e.dataTransfer.files]);
            }}
          >
            <div className="drop-head">Drop your Letterboxd export</div>
            <div className="drop-sub">the .zip, or the CSVs inside it — click to browse</div>
          </button>
          <input
            ref={input}
            type="file"
            accept=".zip,.csv"
            multiple
            hidden
            onChange={(e) => void run([...(e.target.files ?? [])])}
          />

          <ol className="steps">
            <li>
              <b>1.</b> Letterboxd → Settings → Data → Export Your Data
            </li>
            <li>
              <b>2.</b> Drop the zip above. Nothing is uploaded except the film titles, so we can look
              up who directed them.
            </li>
          </ol>

          {state.kind === "error" ? <p className="error">{state.message}</p> : null}
        </>
      ) : null}

      {state.kind === "working" ? (
        <div className="working">
          {state.note}
          <div className="bar">
            <i />
          </div>
        </div>
      ) : null}

      {state.kind === "done" ? <Report analysis={state.analysis} onReset={() => setState({ kind: "idle" })} /> : null}

      <footer>
        <p>
          This product uses the TMDB API but is not endorsed or certified by TMDB. Not affiliated with
          Letterboxd.
        </p>
      </footer>
    </div>
  );
}

function Report({ analysis, onReset }: { analysis: Analysis; onReset: () => void }) {
  const { page, summary, profile, matched, requested } = analysis;
  const unmatched = requested - matched;

  // Three tiers instead of nineteen equal boxes. The old page was 8.6 screens of
  // uniformly-weighted cards with a 5x height spread, which is what made it read
  // as janky: no hierarchy, so nothing looked important.
  const withFinding = [...page.hero, ...page.secondary].filter((s) => s.finding !== "none");
  const features = withFinding.slice(0, 3);
  const compact = withFinding.slice(3);
  const quiet = [...page.hero, ...page.secondary].filter((s) => s.finding === "none");

  return (
    <>
      <div className="audit">
        <div>
          <b>{profile.nRated.toLocaleString()}</b> films rated
        </div>
        <div>
          <b>{matched.toLocaleString()}</b> of {requested.toLocaleString()} matched
          {unmatched > 0 ? <> · {unmatched} unmatched, almost all TV</> : null}
        </div>
        <div>
          <b>{summary.audit.cleanDatedCount.toLocaleString()}</b> reliably dated entries
        </div>
        {summary.reviews.length > 0 ? (
          <div>
            <b>{summary.reviews.length.toLocaleString()}</b> reviews
          </div>
        ) : null}
      </div>

      {/* Tier 1: the three strongest findings, full width, chart at size. */}
      <section className="features">
        {features.map((s, i) => (
          <StatCard key={s.def.id} stat={s} variant="feature" rank={i + 1} />
        ))}
      </section>

      {/* Tier 2: everything else that found something, compact and equal-height. */}
      {compact.length > 0 ? (
        <>
          <p className="section-label">More about you</p>
          <div className="compact-grid">
            {compact.map((s) => (
              <StatCard key={s.def.id} stat={s} variant="compact" />
            ))}
          </div>
        </>
      ) : null}

      {/* Tier 3: real findings that happen to be absences. Demoted, never hidden. */}
      {quiet.length > 0 ? (
        <details className="quiet">
          <summary>{quiet.length} things your films did NOT say</summary>
          <div className="quiet-list">
            {quiet.map((s) => (
              <div key={s.def.id}>
                <b>{s.title}</b>
                <p>{s.copy}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <Withheld page={page} />

      <button type="button" className="reset" onClick={onReset}>
        Start over
      </button>
    </>
  );
}
