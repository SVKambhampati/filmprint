#!/usr/bin/env node
/**
 * Build-time dataset generator.
 *
 *   npm run build:dataset -- <path-to-unzipped-export> [--limit N] [--refetch]
 *   npm run build:dataset -- --report
 *
 * Point it at an unzipped Letterboxd export directory. It resolves every film to
 * a TMDB id, fetches the metadata we keep, and reports the match rate — the
 * number that decides whether this product works at all.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TmdbClient, mapLimit } from "../tmdb/client.ts";
import { Store } from "../store/db.ts";
import { normalizeExport, allFilms } from "../hygiene/normalize.ts";
import { GATES } from "../hygiene/thresholds.ts";
import { emptyStats, resolveOne, type ResolveInput } from "./resolve.ts";

const DB_PATH = process.env.FILMPRINT_DB ?? "data/filmprint.db";

async function readIfPresent(dir: string, file: string): Promise<string> {
  const p = path.join(dir, file);
  return existsSync(p) ? readFile(p, "utf8") : "";
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function row(label: string, value: string | number, note = ""): void {
  console.log(`${label.padEnd(24)}${String(value).padStart(7)}${note ? "  " + note : ""}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const store = new Store(DB_PATH);

  if (args.includes("--report")) {
    report(store);
    store.close();
    return;
  }

  const exportDir = args.find((a) => !a.startsWith("--"));
  if (!exportDir) {
    console.error(
      "usage: npm run build:dataset -- <path-to-unzipped-export> [--limit N] [--refetch]\n" +
        "       npm run build:dataset -- --report",
    );
    process.exitCode = 1;
    store.close();
    return;
  }
  if (!existsSync(exportDir)) {
    console.error(`no such directory: ${exportDir}`);
    process.exitCode = 1;
    store.close();
    return;
  }

  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const refetch = args.includes("--refetch");

  const [diary, ratings, watched, watchlist] = await Promise.all([
    readIfPresent(exportDir, "diary.csv"),
    readIfPresent(exportDir, "ratings.csv"),
    readIfPresent(exportDir, "watched.csv"),
    readIfPresent(exportDir, "watchlist.csv"),
  ]);

  if (!diary && !ratings && !watched && !watchlist) {
    console.error(`found no diary/ratings/watched/watchlist CSVs in ${exportDir}`);
    process.exitCode = 1;
    store.close();
    return;
  }

  const summary = normalizeExport({ diary, ratings, watched, watchlist });
  const a = summary.audit;

  console.log("── hygiene ──────────────────────────────────────────");
  row("diary rows read", a.diaryRowsRead);
  row("  unparseable", a.unparseableDropped);
  row("  duplicates dropped", a.duplicatesDropped, "(same film, same watched date)");
  row("diary entries kept", a.diaryEntriesKept);
  row("  distinct films", a.diaryDistinctFilms);
  row("  joined to film id", a.diaryJoinedToFilmId, `${pct(a.diaryJoinedToFilmId, a.diaryEntriesKept)} via (name, year)`);
  row("  unjoined", a.diaryUnjoined, a.diaryUnjoined > 0 ? "← fell back to title+year key" : "");
  row("  rated / unrated", `${a.ratedEntries}/${a.unratedEntries}`);
  row("  clean-dated", a.cleanDatedCount, `${pct(a.cleanDatedCount, a.diaryEntriesKept)} — safe for temporal stats`);
  row("  bulk-logged", a.bulkLoggedCount, "(import clusters)");
  console.log("");
  row("ratings.csv", a.ratingsRows);
  row("watched.csv", a.watchedRows);
  row("watchlist.csv", a.watchlistRows);
  row("distinct films", a.distinctFilms);

  // The gap between rating-based and date-based sample sizes decides which stats
  // can even render, so surface it here rather than discovering it in the UI.
  console.log("\n── what these numbers allow ─────────────────────────");
  const gate = (name: string, have: number, need: number) => {
    const ok = have >= need;
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(34)} ${String(have).padStart(5)} / ${need} needed`);
  };
  gate("rating distribution stats", a.ratingsRows, GATES.ratingDistribution);
  gate("crowd comparison (contrarian)", a.ratingsRows, GATES.crowdComparison);
  gate("per-person (director/DoP/actor)", a.ratingsRows, GATES.perPerson);
  gate("per-month / per-year slicing", a.cleanDatedCount, GATES.temporalSlicing);
  gate("lag & seasonality", a.cleanDatedCount, GATES.cleanDated);
  gate("watchlist half-life", a.watchlistRows, 25);
  if (a.watchedToDiaryRatio !== null && a.watchedToDiaryRatio > 3) {
    console.log(
      `\n  ! watched/diary ratio is ${a.watchedToDiaryRatio.toFixed(1)}x. This user rates without\n` +
        `    logging diary entries, so taste stats are rich and BEHAVIOUR stats are starved.\n` +
        `    Lean the hero page on rating-based stats for users like this.`,
    );
  }

  const films = allFilms(summary);
  const inputs: ResolveInput[] = [...films.values()]
    .map((f) => ({ filmKey: f.key, name: f.name, year: f.year }))
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  const client = new TmdbClient(process.env.TMDB_API_KEY ?? "", Number(process.env.TMDB_RPS ?? 20));
  const stats = emptyStats();
  stats.total = inputs.length;

  console.log(`\n── resolving ${inputs.length} films ─────────────────────────`);
  const started = Date.now();
  let done = 0;
  await mapLimit(inputs, 12, async (input) => {
    await resolveOne(input, client, store, stats, { refetch });
    done++;
    if (done % 25 === 0 || done === inputs.length) {
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${done}/${inputs.length}  ·  ${client.callCount} API calls  ·  ${rate.toFixed(0)}/s   `);
    }
  });
  process.stdout.write("\n");

  const unresolved = inputs.filter((i) => {
    const hit = store.lookupFilm(i.filmKey);
    return !hit || hit.tmdbId == null;
  });
  const matched = stats.total - unresolved.length;

  console.log("\n── match rate ───────────────────────────────────────");
  row("matched", matched, `of ${stats.total}  →  ${pct(matched, stats.total)}`);
  row("  cache hits", stats.cacheHits, "(zero API cost)");
  row("  newly resolved", stats.newlyResolved);
  row("  newly unmatched", stats.newlyUnmatched);
  row("films fetched", stats.filmsFetched);
  row("already stored", stats.filmsAlreadyStored);
  row("TMDB API calls", client.callCount);
  row("elapsed", `${((Date.now() - started) / 1000).toFixed(0)}s`);

  if (stats.errors.length > 0) {
    console.log(`\nerrors: ${stats.errors.length}`);
    for (const e of stats.errors.slice(0, 8)) console.log(`  ${e.filmKey}: ${e.message}`);
    if (stats.errors.length > 8) console.log(`  ...and ${stats.errors.length - 8} more`);
  }

  const rate = stats.total === 0 ? 0 : matched / stats.total;
  console.log("");
  if (rate >= 0.95) console.log("✓ match rate is healthy. The stats layer can trust this.");
  else if (rate >= 0.85) console.log("⚠ match rate is usable but the tail needs attention — see the unmatched list.");
  else console.log("✗ match rate is too low to build stats on. Inspect the unmatched list before going further.");

  report(store);
  store.close();
}

function report(store: Store): void {
  const s = store.stats();
  console.log("\n── store ────────────────────────────────────────────");
  row("films stored", s.films);
  row("films resolved", s.resolved);
  row("films unresolved", s.unresolved);

  const worst = store.db
    .prepare(
      `SELECT film_key, title, year, seen_count, best_score
       FROM unmatched ORDER BY best_score DESC, seen_count DESC LIMIT 25`,
    )
    .all() as { film_key: string; title: string; year: number | null; seen_count: number; best_score: number | null }[];

  if (worst.length > 0) {
    console.log("\nunmatched (highest score first — these are the near-misses worth fixing):");
    for (const u of worst) {
      const score = u.best_score == null ? "—" : u.best_score.toFixed(2);
      console.log(`  score ${score}  ${u.title} (${u.year ?? "?"})`);
    }
  }

  const methods = store.db
    .prepare("SELECT method, COUNT(*) AS n FROM film_map GROUP BY method ORDER BY n DESC")
    .all() as { method: string; n: number }[];
  if (methods.length > 0) {
    console.log("\nresolution methods:");
    for (const m of methods) console.log(`  ${m.method.padEnd(14)} ${m.n}`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nerror: ${(err as Error).message}`);
  process.exitCode = 1;
}
