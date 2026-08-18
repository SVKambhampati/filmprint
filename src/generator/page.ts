#!/usr/bin/env node
/**
 * Show the page a given export would produce:
 *
 *   npm run page -- <path-to-unzipped-export>
 *
 * Prints the hero row, the secondary stats, and — most usefully — everything
 * that got gated out and why. Use it to sanity-check that a real user gets a
 * full page before building any of the stats themselves.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Store } from "../store/db.ts";
import { normalizeExport, allFilms } from "../hygiene/normalize.ts";
import { parseCsv } from "../hygiene/csv.ts";
import { buildProfile } from "../stats/profile.ts";
import { selectStats, headroomOf, type SampleProfile } from "../stats/registry.ts";

const DB_PATH = process.env.FILMPRINT_DB ?? "data/filmprint.db";

async function readIfPresent(dir: string, file: string): Promise<string> {
  const p = path.join(dir, file);
  return existsSync(p) ? readFile(p, "utf8") : "";
}

const exportDir = process.argv[2];
if (!exportDir || !existsSync(exportDir)) {
  console.error("usage: npm run page -- <path-to-unzipped-export>");
  process.exit(1);
}

const [diary, ratings, watched, watchlist, reviews] = await Promise.all([
  readIfPresent(exportDir, "diary.csv"),
  readIfPresent(exportDir, "ratings.csv"),
  readIfPresent(exportDir, "watched.csv"),
  readIfPresent(exportDir, "watchlist.csv"),
  readIfPresent(exportDir, "reviews.csv"),
]);

const summary = normalizeExport({ diary, ratings, watched, watchlist });
const nReviews = parseCsv(reviews).filter((r) => (r["review"] ?? "").trim().length > 0).length;

const store = new Store(DB_PATH);
const keys = [...allFilms(summary).keys()];
const joined = store.joinedFilms(keys);

const profile = buildProfile(summary, { nReviews, joined });
const sel = selectStats(profile);

console.log("── sample profile ───────────────────────────────────");
for (const [k, v] of Object.entries(profile) as [keyof SampleProfile, number][]) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}`);
}
console.log(`  ${"(films joined to TMDB)".padEnd(22)} ${String(joined.size).padStart(6)} of ${keys.length}`);

console.log(`\n── hero row (${sel.hero.length}) ─────────────────────────────────`);
for (const d of sel.hero) {
  const h = (headroomOf(d, profile) * 3).toFixed(1);
  console.log(`  ${d.name}`);
  console.log(`      ${d.category} · R${d.revealing} S${d.shareable} · ${d.tone} · ${h}x its minimum`);
}

console.log(`\n── secondary (${sel.secondary.length}) ──────────────────────────────`);
for (const d of sel.secondary) console.log(`  ${d.name.padEnd(46)} ${d.category}`);

console.log(`\n── gated out (${sel.gated.length}) ──────────────────────────────`);
for (const g of sel.gated) {
  const why = g.missing.map((m) => `${m.metric} ${m.have}/${m.min}`).join(", ");
  console.log(`  ${g.def.name.padEnd(46)} ${why}`);
}

console.log(`\n── blocked (${sel.blocked.length}) ────────────────────────────────`);
for (const b of sel.blocked) console.log(`  ${b.def.name.padEnd(46)} ${b.reason.split(".")[0]}.`);

const withCaveats = [...sel.hero, ...sel.secondary].filter((d) => d.caveat);
console.log(`\n── caveats that must appear in the UI (${withCaveats.length}) ────────`);
for (const d of withCaveats) console.log(`  ${d.name}\n      ${d.caveat}`);

store.close();
