#!/usr/bin/env node
/**
 * Compute and print the hero stats for an export:
 *   npm run stats -- <path-to-unzipped-export>
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Store } from "../store/db.ts";
import { normalizeExport, allFilms } from "../hygiene/normalize.ts";
import { parseCsv } from "../hygiene/csv.ts";
import { buildProfile } from "../stats/profile.ts";
import { buildContext } from "../stats/context.ts";
import { scaleCollapse } from "../stats/impl/scale-collapse.ts";
import { harshnessSplit } from "../stats/impl/harshness-split.ts";
import { tasteCrystallization } from "../stats/impl/taste-crystallization.ts";
import { comfortObject } from "../stats/impl/comfort-object.ts";
import { obscurityLedger } from "../stats/impl/obscurity-ledger.ts";
import { abandonedDiscovery } from "../stats/impl/abandoned-discovery.ts";

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error("usage: npm run stats -- <path-to-unzipped-export>");
  process.exit(1);
}
const read = async (f: string) => (existsSync(path.join(dir, f)) ? readFile(path.join(dir, f), "utf8") : "");

const summary = normalizeExport({
  diary: await read("diary.csv"),
  ratings: await read("ratings.csv"),
  watched: await read("watched.csv"),
  watchlist: await read("watchlist.csv"),
});
const nReviews = parseCsv(await read("reviews.csv")).filter((r) => (r["review"] ?? "").trim()).length;

const store = new Store(process.env.FILMPRINT_DB ?? "data/filmprint.db");
const joined = store.joinedFilms([...allFilms(summary).keys()]);
const tmdbIds = [...joined.values()].map((f) => f.tmdbId);
const ctx = buildContext({
  summary,
  profile: buildProfile(summary, { nReviews, joined }),
  joined,
  genres: store.genresFor(tmdbIds),
  crew: store.crewFor(tmdbIds),
});

const h = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 48 - t.length))}`);

h("Your scale");
const sc = scaleCollapse(ctx);
console.log(`  using ${sc.bitsUsed.toFixed(2)} of ${sc.maxBits.toFixed(2)} bits  [${sc.ci.lo.toFixed(2)}, ${sc.ci.hi.toFixed(2)}]`);
console.log(`  mode ${sc.mode}★ · ${(sc.modalBandShare * 100).toFixed(0)}% of ratings within ${sc.mode}±0.5`);
console.log(`  never used: ${sc.unused.length ? sc.unused.map((u) => u + "★").join(", ") : "(uses all ten)"}`);
console.log("  " + sc.histogram.map((b) => `${b.rating}:${b.count}`).join("  "));

h("Harsh or contrarian?");
const hs = harshnessSplit(ctx);
console.log(`  quadrant: ${hs.quadrant ?? "(withheld — not enough crowd-comparable films)"}`);
console.log(`  level offset ${hs.level.offset >= 0 ? "+" : ""}${hs.level.offset.toFixed(2)}★ (you ${hs.level.actualMean.toFixed(2)} vs expected ${hs.level.predictedMean.toFixed(2)})`);
console.log(`  rank agreement (tau-b) ${hs.rankAgreement.toFixed(3)} on ${hs.n} films · ${hs.level.droppedLowVotes} dropped as too obscure to compare`);
console.log("  biggest disagreements:");
for (const d of hs.disagreements) {
  console.log(`    ${d.rankGap > 0 ? "you rate higher" : "you rate lower "}  ${d.userRating}★ vs crowd ${d.crowdRating.toFixed(1)}/10  ${d.name}`);
}

h("When your taste formed");
const tc = tasteCrystallization(ctx);
console.log(`  ${tc.binWidth}-year bins`);
if (tc.peak) {
  console.log(`  peak: ${tc.peak.year}-${tc.peak.year + tc.peak.width - 1} at ${tc.peak.shrunkMean.toFixed(2)}★ on ${tc.peak.n} films`);
  console.log(`    ${tc.peak.topFilms.join(" · ")}`);
} else {
  console.log(`  no peak: ${tc.noPeakReason}`);
}
const top = [...tc.bins].sort((a, b) => b.shrunkMean - a.shrunkMean).slice(0, 5);
for (const b of top) console.log(`    ${b.year}s  ${b.shrunkMean.toFixed(2)}★  (raw ${b.rawMean.toFixed(2)}, n=${b.n})`);

h("Your comfort object");
const co = comfortObject(ctx);
if (co.top) console.log(`  most rewatched: ${co.top.name} — at least ${co.top.atLeastTimes} times`);
if (co.seeking && co.returning) {
  console.log(`  seeking   n=${co.seeking.n}  median year ${co.seeking.medianReleaseYear}  runtime ${co.seeking.medianRuntime}m  ${co.seeking.topGenres.join("/")}`);
  console.log(`  returning n=${co.returning.n}  median year ${co.returning.medianReleaseYear}  runtime ${co.returning.medianRuntime}m  ${co.returning.topGenres.join("/")}`);
} else {
  console.log(`  (profile withheld — only ${co.rewatchEntries} rewatch entries)`);
}

h("Your best obscure finds");
const ob = obscurityLedger(ctx);
console.log(`  ${ob.candidates} films rated 4.5+ · ${ob.uncohorted} in cohorts too small to judge`);
if (ob.finds.length === 0) {
  console.log(`  (nothing qualifies — ${ob.notObscureEnough} were well-voted for their cohort. Everything you`);
  console.log(`   rate highly is popular. That is a finding, not an empty state.)`);
}
for (const f of ob.finds.slice(0, 8)) {
  console.log(`    z=${f.cohortZ.toFixed(2)}  ${String(f.voteCount).padStart(6)} votes  ${f.rating}★  ${f.name}  [${f.cohort}, n=${f.cohortN}]`);
}

h("Abandoned discoveries");
const ad = abandonedDiscovery(ctx);
for (const a of ad.slice(0, 8)) console.log(`    ${a.rating}★  ${a.film}  — ${a.director}, seen 1`);
if (ad.length === 0) console.log("    (none)");

store.close();
