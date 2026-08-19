# filmprint

> See your filmprint. Upload your Letterboxd export — we'll show you what your
> films say about you.

Letterboxd Pro has a very good *inventory* page. It counts things accurately, and
it tells you almost nothing about yourself. Every stat in filmprint is a
**relationship** rather than a total: rating vs. runtime, aspiration vs.
behaviour, first watch vs. rewatch, you vs. the crowd.

Free, no accounts, no subscription.

## Status

Early. What exists today is the foundation, not the site:

| Layer | State |
|---|---|
| CSV parsing (RFC 4180, dependency-free) | done, tested |
| Hygiene: dedupe, TV filtering, backfill detection | done, tested |
| Sample-size gates and shrinkage | done, tested |
| Statistical primitives (tau-b, bias-corrected entropy, bootstrap, permutation) | done, tested |
| Crowd calibration (harshness anchor) | done, **provisional constants** |
| TMDB schema, client, matcher | done, tested |
| SQLite store | done, tested |
| Dataset generator CLI | done — **98.6% match rate on a real 1,889-film export** |
| Live matcher check (`npm run check:matcher`) | 22/22 against real TMDB |
| Stat registry + page selector | done, tested |
| 22 of 28 stats implemented | done, tested |
| Page composition (`composePage`) | done, tested |
| Remaining stats | 2 blocked on unbuilt prerequisites |
| Web UI | drop-a-zip → full page, client-side |
| Lookup endpoint | not started (dev uses a static payload) |

## Getting started

```bash
npm install
cp .env.example .env      # then paste your TMDB v3 API key
```

To run the app, build a metadata payload from an export and start the dev server:

```bash
npm run dump:payload -- ~/Downloads/letterboxd-export
npm run dev
```

`web/public/payload.json` is what the lookup endpoint will eventually return; keeping
it as a file means the UI can be built without a server. It is gitignored, as is
`web/public/demo/` — one is bulk TMDB metadata and the other is a real person's
viewing history, and this repo is public. Append `?demo` in development to load
from `web/public/demo/` instead of dragging a file each reload.

Export your data from Letterboxd (Settings → account export — this is available
to all accounts, not just Pro), unzip it, then:

```bash
npm run build:dataset -- ~/Downloads/letterboxd-export
```

That reports the hygiene audit and the **match rate**, which is the number that
decides whether any of this works. Build the generator before the UI, because if
you match 70% of a real library then every chart downstream is wrong and no
amount of design fixes it.

```bash
npm test               # 211 tests, no network
npm run typecheck
npm run check:matcher  # 22 live cases against real TMDB (~23 API calls)
npm run build:dataset -- --report    # store contents + top unmatched, no network
```

`check:matcher` is the one to run after touching `src/tmdb/match.ts`. It covers
the cases that actually break matching: remakes sharing a title (Dune, Solaris,
Nosferatu), original-language titles (기생충), diacritics and punctuation
(Amélie, WALL·E), festival-vs-release year gaps, and a film that must be
*refused* rather than guessed.

## Design constraints

These are decisions, not TODOs. Changing them means re-reading the reasoning.

**CSV upload is the only way in, permanently.** Letterboxd's API has been in
closed beta for years, and as of December 2025 they block scrapers. There will
never be a "just type your username" path.

**The metadata store is a build-time artefact, never a public file.** TMDB's
terms forbid redistributing their data; a 50k-film JSON blob on a CDN is
redistribution. A thin lookup endpoint reads from SQLite instead. The browser
sends film slugs and gets metadata back — it never sends ratings or dates, so
"we never see what you thought of anything" stays true.

**Matching is solved once per film, never once per user.** `film_map` is the
compounding asset, and the effect is measured, not theoretical: the first run
over 1,889 films took **187s and 3,764 API calls**; the second took **2s and 55
calls**. Every miss is recorded in `unmatched` with a `seen_count`, so hand-fixing
the top of that list has leverage across everyone.

**Two id spaces, and confusing them breaks every join.** `ratings.csv`,
`watched.csv` and `watchlist.csv` carry Letterboxd FILM ids. `diary.csv` carries
DIARY ENTRY ids, which share zero overlap. A diary row joins to a film on
`(Name, Year)`, not on its URI. This is the single easiest thing to get wrong
here — the first live run matched nothing because of it.

**There is no fixed hero row — the page is computed per user.** Logging style
varies too much for a hand-picked front page. One real export had 1,868 rated
films against 100 diary entries (79 clean-dated) and 21 watchlist entries, a
watched-to-diary ratio of 18.7x. A user who logs every watch same-day would gate
out a completely different set.

So every stat declares its sample requirements in `src/stats/registry.ts`, and
`selectStats` checks them against the actual export and ranks the survivors by
revealing x shareable x how comfortably they clear their gates. Two editorial
constraints ride along: at most two stats per category (so the hero row is not
six versions of one idea), and at least one stat that does not sting (a page of
pure unflattering findings reads as an attack).

Run `npm run page -- <export>` to see the page any export would produce,
including what got gated out and why. Build the selector before the stats:
retrofitting "am I allowed to render?" into 28 implementations is miserable.

**Non-commercial, and that is load-bearing.** TMDB's API is free for
non-commercial use with attribution. Anything "created for the primary purpose of
revenue generation" needs a commercial licence negotiated with them — so adding
a paid tier is a conversation with TMDB, not a Stripe integration.

**Demote, never hide.** A stat that clears its sample gate can still have
nothing to say — two of six did on the export used to build this. A null result
loses its hero slot, not its place on the page, because "nothing you rate highly
is obscure" is a real observation about a person and suppressing it throws
information away. Every stat therefore returns a `StatResult` carrying a
mandatory sentence in *both* branches of the union, so a blank card cannot ship
by accident.

**A stat may correct its own framing.** The registry names each stat for its
expected conclusion ("Your scale has collapsed"), which is wrong whenever the
finding inverts. A stat can override its title and tone for a given user, or the
card contradicts its own copy — this was a real bug, caught by a test asserting
no title claims collapse over copy denying it.

**No stat ships without its hazard handled.** Shrinkage on every group mean,
bias correction on every entropy, a permutation test on anything that reports the
extreme of many comparisons, and a sample-size gate from `src/hygiene/thresholds.ts`.
A misleading stat costs more trust than a missing one earns.

**TMDB's crowd is not a usable reference for every library.** The crowd-comparison
stats need a film to have enough votes for its average to mean anything, and
TMDB's voter base is heavily English-language. On the export used to build this,
that filter removed **516 of 522 Telugu films and 113 of 118 Tamil films, against
13 of 958 English ones** — so a verdict about "your taste" was really a verdict
about 55% of a library, chosen along a language line.

The stat now discloses its own coverage in its copy and computes a separate
verdict per language above a minimum sample, headlining a divergence when the
groups disagree. When a language cannot be evaluated at all, that is stated rather
than averaged over. The durable fix is a reference distribution built from
consenting users, which is the same corpus a fitted calibration curve needs.

**Watchlist conversion is not computable, and this was verified.** The original
design ranked "watchlist half-life" — survival analysis on time from added to
watched — as a hero stat and called it one of the most robust available. It is
impossible from a single export. Letterboxd removes a film from the watchlist
when you log it, and the export contains only the *current* watchlist, so every
converted film has left the file and the diary keeps no record of when it was
added. Checked against a real export: **zero overlap** between watchlist and
watched, by film id and by (name, year). Kaplan-Meier would see no events at all.

What survives is an age list — how long the remaining films have sat — which is
what people screenshot anyway. Unreleased films are excluded: a film added in
2025 that opens in 2028 is a wishlist entry, and counting it as neglect is simply
wrong. On the test export 20 of 21 watchlist films were unreleased.

## Known gaps

- **`src/stats/calibration.ts` constants are provisional.** They are seeded from
  population means, not fitted. Until refit, the harshness axis is directional
  only — report the quadrant, never a precise number of stars.
- **TV is detected by TMDB match failure, not by anything in the export.** This
  was verified, not assumed: on a real 1,889-film export every one of the 27
  unmatched entries was a TV series (Chernobyl, Squid Game, Loki, WandaVision,
  Baby Reindeer...). boxd.it URIs carry no film-vs-TV signal, so the unmatched
  bucket *is* the TV bucket. The UI must say "we matched 1,862 of 1,889 — the
  rest are TV, which we don't cover" rather than implying a matching failure.
- **The watchlist graveyard is biased and unfixably so.** Films added and then
  deleted without watching appear nowhere in the export, so anyone who purges
  their watchlist gets an inflated conversion rate. This has to be said in the
  UI, not just here.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
The TMDB logo and this notice must appear in the app's credits before it ships
publicly — it is a condition of the free API, not a nicety.

Not affiliated with, endorsed by, or connected to Letterboxd.
