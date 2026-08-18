#!/usr/bin/env node
/**
 * Build-time dataset generator.
 *
 *   npm run build:dataset -- <path-to-unzipped-export> [--limit N] [--refetch]
 *   npm run build:dataset -- --report
 *
 * Point it at an unzipped Letterboxd export directory. It resolves every film
 * slug to a TMDB id, fetches the metadata we keep, and reports the match rate —
 * which is the number that decides whether this product works at all.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TmdbClient, mapLimit } from "../tmdb/client.ts";
import { Store } from "../store/db.ts";
import { normalizeDiary, normalizeRatings, normalizeWatchlist, allSlugs } from "../hygiene/normalize.ts";
import { emptyStats, resolveOne, type ResolveInput } from "./resolve.ts";

const DB_PATH = process.env.FILMPRINT_DB ?? "data/filmprint.db";

async function readIfPresent(dir: string, file: string): Promise<string> {
  const p = path.join(dir, file);
  return existsSync(p) ? readFile(p, "utf8") : "";
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
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

  const [diaryText, ratingsText, watchlistText] = await Promise.all([
    readIfPresent(exportDir, "diary.csv"),
    readIfPresent(exportDir, "ratings.csv"),
    readIfPresent(exportDir, "watchlist.csv"),
  ]);

  if (!diaryText && !ratingsText && !watchlistText) {
    console.error(`found no diary.csv, ratings.csv or watchlist.csv in ${exportDir}`);
    process.exitCode = 1;
    store.close();
    return;
  }

  const { entries: diary, audit } = normalizeDiary(diaryText);
  const ratings = normalizeRatings(ratingsText);
  const watchlist = normalizeWatchlist(watchlistText);

  console.log("── hygiene ──────────────────────────────────────────");
  console.log(`diary rows read        ${audit.diaryRowsRead}`);
  console.log(`  duplicates dropped   ${audit.duplicatesDropped}`);
  console.log(`  non-film dropped     ${audit.nonFilmDropped}  (TV entries, malformed rows)`);
  console.log(`  unparseable dropped  ${audit.unparseableDropped}`);
  console.log(`usable diary entries   ${diary.length}`);
  console.log(`  rated / unrated      ${audit.ratedCount} / ${audit.unratedCount}`);
  console.log(`  clean-dated          ${audit.cleanDatedCount}  ${pct(audit.cleanDatedCount, diary.length)} — safe for temporal stats`);
  console.log(`  bulk-logged          ${audit.bulkLoggedCount}  (import clusters)`);
  console.log(`ratings.csv rows       ${ratings.length}`);
  console.log(`watchlist rows         ${watchlist.length}`);

  const slugMap = allSlugs({ diary, ratings, watchlist });
  const inputs: ResolveInput[] = [...slugMap.entries()]
    .map(([slug, v]) => ({ slug, name: v.name, year: v.year }))
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`\ndistinct films          ${slugMap.size}${inputs.length < slugMap.size ? ` (resolving ${inputs.length} due to --limit)` : ""}`);

  const client = new TmdbClient(process.env.TMDB_API_KEY ?? "", Number(process.env.TMDB_RPS ?? 20));
  const stats = emptyStats();
  stats.total = inputs.length;

  console.log("\n── resolving ────────────────────────────────────────");
  let done = 0;
  await mapLimit(inputs, 12, async (input) => {
    await resolveOne(input, client, store, stats, { refetch });
    done++;
    if (done % 50 === 0 || done === inputs.length) {
      process.stdout.write(`\r  ${done}/${inputs.length} films  ·  ${client.callCount} API calls`);
    }
  });
  process.stdout.write("\n");

  const matched = stats.total - countUnresolved(store, inputs.map((i) => i.slug));
  console.log("\n── match rate ───────────────────────────────────────");
  console.log(`matched                ${matched} of ${stats.total}  ${pct(matched, stats.total)}`);
  console.log(`  cache hits           ${stats.cacheHits}  (zero API cost)`);
  console.log(`  newly resolved       ${stats.newlyResolved}`);
  console.log(`  newly unmatched      ${stats.newlyUnmatched}`);
  console.log(`films fetched          ${stats.filmsFetched}`);
  console.log(`films already stored   ${stats.filmsAlreadyStored}`);
  console.log(`TMDB API calls         ${client.callCount}`);
  if (stats.errors.length > 0) {
    console.log(`\nerrors                 ${stats.errors.length}`);
    for (const e of stats.errors.slice(0, 10)) console.log(`  ${e.slug}: ${e.message}`);
    if (stats.errors.length > 10) console.log(`  ...and ${stats.errors.length - 10} more`);
  }

  const rate = stats.total === 0 ? 0 : matched / stats.total;
  console.log("");
  if (rate >= 0.95) console.log("✓ match rate is healthy. The stats layer can trust this.");
  else if (rate >= 0.85) console.log("⚠ match rate is usable but the tail needs attention — see `--report`.");
  else console.log("✗ match rate is too low to build stats on. Inspect the unmatched table before going further.");

  report(store);
  store.close();
}

function countUnresolved(store: Store, slugs: readonly string[]): number {
  let n = 0;
  for (const s of slugs) {
    const hit = store.lookupSlug(s);
    if (!hit || hit.tmdbId == null) n++;
  }
  return n;
}

function report(store: Store): void {
  const s = store.stats();
  console.log("\n── store ────────────────────────────────────────────");
  console.log(`films stored           ${s.films}`);
  console.log(`slugs resolved         ${s.resolved}`);
  console.log(`slugs unresolved       ${s.unresolved}`);

  const worst = store.db
    .prepare(
      `SELECT slug, title, year, seen_count, best_score
       FROM unmatched ORDER BY seen_count DESC, best_score DESC LIMIT 15`,
    )
    .all() as { slug: string; title: string; year: number | null; seen_count: number; best_score: number | null }[];

  if (worst.length > 0) {
    console.log("\ntop unmatched (fix these by hand first — they recur across users):");
    for (const u of worst) {
      const score = u.best_score == null ? "—" : u.best_score.toFixed(2);
      console.log(`  ${String(u.seen_count).padStart(4)}x  score ${score}  ${u.title} (${u.year ?? "?"})  [${u.slug}]`);
    }
  }

  const methods = store.db
    .prepare("SELECT method, COUNT(*) AS n FROM slug_map GROUP BY method ORDER BY n DESC")
    .all() as { method: string; n: number }[];
  if (methods.length > 0) {
    console.log("\nresolution methods:");
    for (const m of methods) console.log(`  ${m.method.padEnd(14)} ${m.n}`);
  }
}

try {
  await main();
} catch (err) {
  // Config problems (a missing API key, an unreadable export) are user errors,
  // not crashes. Print the message, skip the stack trace.
  console.error(`\nerror: ${(err as Error).message}`);
  process.exitCode = 1;
}
