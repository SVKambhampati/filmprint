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
| Dataset generator CLI | done, needs a real export to validate match rate |
| Individual stats | not started |
| Web UI | not started |

## Getting started

```bash
npm install
cp .env.example .env      # then paste your TMDB v3 API key
```

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
npm test          # 58 tests
npm run typecheck
npm run build:dataset -- --report    # store contents + top unmatched, no network
```

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

**Matching is solved once per film, never once per user.** `slug_map` is the
compounding asset: user #1 pays the fuzzy-match cost, user #500 gets an exact
hit. Every miss is recorded in `unmatched` with a `seen_count`, so hand-fixing
the top of that list has leverage across everyone.

**Non-commercial, and that is load-bearing.** TMDB's API is free for
non-commercial use with attribution. Anything "created for the primary purpose of
revenue generation" needs a commercial licence negotiated with them — so adding
a paid tier is a conversation with TMDB, not a Stripe integration.

**No stat ships without its hazard handled.** Shrinkage on every group mean,
bias correction on every entropy, a permutation test on anything that reports the
extreme of many comparisons, and a sample-size gate from `src/hygiene/thresholds.ts`.
A misleading stat costs more trust than a missing one earns.

## Known gaps

- **`src/stats/calibration.ts` constants are provisional.** They are seeded from
  population means, not fitted. Until refit, the harshness axis is directional
  only — report the quadrant, never a precise number of stars.
- **TV detection is untested against a real export.** We drop anything whose
  Letterboxd URI is not under `/film/`, which is a guess about how TV entries are
  serialised. Verify against an export containing TV before trusting the count.
- **The watchlist graveyard is biased and unfixably so.** Films added and then
  deleted without watching appear nowhere in the export, so anyone who purges
  their watchlist gets an inflated conversion rate. This has to be said in the
  UI, not just here.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.
The TMDB logo and this notice must appear in the app's credits before it ships
publicly — it is a condition of the free API, not a nicety.

Not affiliated with, endorsed by, or connected to Letterboxd.
