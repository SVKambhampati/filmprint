#!/usr/bin/env node
/**
 * Compose and print the page for an export:
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
import { composePage } from "../stats/compose.ts";
import { harshnessSplit } from "../stats/impl/harshness-split.ts";

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
const profile = buildProfile(summary, { nReviews, joined });
const ctx = buildContext({
  summary, profile, joined,
  genres: store.genresFor(tmdbIds),
  crew: store.crewFor(tmdbIds),
  countries: store.countriesFor(tmdbIds),
  cast: store.castFor(tmdbIds),
});

const page = composePage(ctx, profile);

// Coverage detail for the crowd stats, since it qualifies every claim they make.
const hs = harshnessSplit(ctx).data;

/** Wrap prose to a readable width so the terminal output stays legible. */
function wrap(text: string, width = 76, indent = "      "): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

const MARK = { strong: "●", weak: "◐", none: "○" } as const;

console.log(`\n════ HERO (${page.hero.length}) ════════════════════════════════════════════`);
for (const c of page.hero) {
  console.log(`\n  ${MARK[c.finding]} ${c.title}   [${c.def.category} · ${c.tone}]`);
  console.log(wrap(c.copy));
}

console.log(`\n════ SECONDARY (${page.secondary.length}) ═══════════════════════════════════`);
for (const c of page.secondary) {
  console.log(`\n  ${MARK[c.finding]} ${c.title}   [${c.finding}]`);
  console.log(wrap(c.copy));
}

console.log(`\n════ CROWD COVERAGE ══════════════════════════════════════`);
console.log(`  compared ${hs.coverage.compared} of ${hs.coverage.rated} rated films (${(hs.coverage.share * 100).toFixed(0)}%)`);
for (const w of hs.coverage.worstExcluded) {
  console.log(`    ${w.language.padEnd(4)} lost ${String(w.excluded).padStart(4)} of ${w.total}`);
}
if (hs.byLanguage.length > 0) {
  console.log("  per-language verdicts:");
  for (const l of hs.byLanguage) {
    console.log(`    ${l.language.padEnd(4)} n=${String(l.n).padStart(4)}  offset ${l.offset >= 0 ? "+" : ""}${l.offset.toFixed(2)}★  tau ${l.rankAgreement.toFixed(3)}`);
  }
}

console.log(`\n════ NOT SHOWN ═══════════════════════════════════════════`);
console.log(`\n  gated by sample size (${page.gated.length}):`);
for (const g of page.gated) {
  console.log(`    ${g.def.name.padEnd(44)} ${g.missing.map((m) => `${m.metric} ${m.have}/${m.min}`).join(", ")}`);
}
console.log(`\n  blocked pending a fix (${page.blocked.length}):`);
for (const b of page.blocked) console.log(`    ${b.def.name}`);
console.log(`\n  declared but not built yet (${page.unimplemented.length}):`);
for (const u of page.unimplemented) console.log(`    ${u.name}`);

store.close();
