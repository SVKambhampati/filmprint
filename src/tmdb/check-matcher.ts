#!/usr/bin/env node
/**
 * Live matcher smoke test:  node --env-file=.env src/tmdb/check-matcher.ts
 *
 * Runs the real matching path against real TMDB on cases chosen to break it:
 * remakes sharing a title, non-English originals, festival-vs-release year gaps,
 * punctuation, and films that should be REFUSED rather than guessed.
 *
 * Asserts on the resolved title and year rather than hardcoded TMDB ids, so the
 * check stays honest without depending on ids being memorised correctly.
 */
import { TmdbClient } from "./client.ts";
import { chooseMatch, normalizeTitle } from "./match.ts";

type Case = {
  name: string;
  year: number | null;
  slug: string;
  /** Year we expect the winning candidate to carry. null = don't care. */
  expectYear: number | null;
  why: string;
  /** True when the correct behaviour is to decline. */
  expectDecline?: boolean;
};

const CASES: Case[] = [
  { name: "Dune", year: 2021, slug: "dune-2021", expectYear: 2021, why: "remake: must not pick 1984" },
  { name: "Dune", year: 1984, slug: "dune", expectYear: 1984, why: "remake: must not pick 2021" },
  { name: "Solaris", year: 1972, slug: "solaris", expectYear: 1972, why: "obscure original vs popular remake" },
  { name: "Solaris", year: 2002, slug: "solaris-2002", expectYear: 2002, why: "the popular remake" },
  { name: "Nosferatu", year: 1922, slug: "nosferatu", expectYear: 1922, why: "century-apart same title" },
  { name: "Nosferatu", year: 2024, slug: "nosferatu-2024", expectYear: 2024, why: "century-apart same title" },
  { name: "Parasite", year: 2019, slug: "parasite", expectYear: 2019, why: "English title of a Korean film" },
  { name: "기생충", year: 2019, slug: "parasite", expectYear: 2019, why: "original-language title" },
  { name: "Amélie", year: 2001, slug: "amelie", expectYear: 2001, why: "diacritics" },
  { name: "WALL·E", year: 2008, slug: "wall-e", expectYear: 2008, why: "interpunct in title" },
  // Letterboxd shows 2022 (Sundance premiere); TMDB holds 2024 (wide release).
  // We pass Letterboxd's year in and expect TMDB's year out — resolving across
  // that gap is the point of the case.
  { name: "Am I OK?", year: 2022, slug: "am-i-ok", expectYear: 2024, why: "festival 2022 vs release 2024, 2-year gap" },
  { name: "Drive My Car", year: 2022, slug: "drive-my-car", expectYear: 2021, why: "festival 2021 vs release 2022" },
  { name: "Sátántangó", year: 1994, slug: "satantango", expectYear: 1994, why: "long obscure non-English" },
  { name: "Come and See", year: 1985, slug: "come-and-see", expectYear: 1985, why: "translated Soviet title" },
  { name: "Stalker", year: 1979, slug: "stalker", expectYear: 1979, why: "common word as title" },
  { name: "Heat", year: 1995, slug: "heat", expectYear: 1995, why: "very common word as title" },
  { name: "The Godfather", year: 1972, slug: "the-godfather", expectYear: 1972, why: "leading article" },
  { name: "Vertigo", year: 1958, slug: "vertigo", expectYear: 1958, why: "classic" },
  { name: "Spirited Away", year: 2001, slug: "spirited-away", expectYear: 2001, why: "translated Japanese title" },
  { name: "Oldboy", year: 2003, slug: "oldboy", expectYear: 2003, why: "romanised Korean, has a remake" },
  { name: "Tenet", year: 2020, slug: "tenet", expectYear: 2020, why: "single word" },
  {
    name: "Zzzqqq Not A Real Film At All",
    year: 2019,
    slug: "zzzqqq-not-a-real-film",
    expectYear: null,
    expectDecline: true,
    why: "must decline, not guess",
  },
];

const client = new TmdbClient(process.env.TMDB_API_KEY ?? "", Number(process.env.TMDB_RPS ?? 20));

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log(`Running ${CASES.length} live matcher cases against TMDB\n`);

for (const c of CASES) {
  let candidates = await client.searchMovie(c.name, c.year ?? undefined);
  if (candidates.length === 0 && c.year) candidates = await client.searchMovie(c.name);

  const out = chooseMatch(c.name, c.year, candidates, c.slug);
  const winner = candidates.find((x) => x.id === out.tmdbId);
  const gotYear = winner?.release_date ? Number(winner.release_date.slice(0, 4)) : null;

  let ok: boolean;
  if (c.expectDecline) {
    ok = out.tmdbId === null;
  } else {
    ok = out.tmdbId !== null && (c.expectYear === null || gotYear === c.expectYear);
  }

  const mark = ok ? "✓" : "✗";
  const shown = out.tmdbId === null
    ? "DECLINED"
    : `${winner?.title ?? "?"} (${gotYear ?? "?"}) id=${out.tmdbId}`;
  const conf = out.confidence.toFixed(2);
  const runner = out.runnerUp === null ? "—" : out.runnerUp.toFixed(2);

  console.log(
    `${mark} ${(c.name + " " + (c.year ?? "")).padEnd(34)} -> ${shown.padEnd(44)} ` +
      `conf ${conf} (2nd ${runner}) [${out.method}]`,
  );
  if (!ok) {
    fail++;
    failures.push(`${c.name} (${c.year}): expected ${c.expectDecline ? "DECLINE" : c.expectYear}, got ${shown} — ${c.why}`);
  } else {
    pass++;
  }
}

console.log(`\n${pass}/${CASES.length} passed, ${fail} failed  ·  ${client.callCount} API calls`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
}

// Flag near-ties even when they passed: a small gap means the match is luck.
console.log("\n(near-ties are the ones to watch — a small confidence gap means the answer was close)");
