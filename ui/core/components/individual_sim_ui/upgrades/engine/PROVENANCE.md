# Engine port provenance

Every file under `engine/` traces to a `packages/core/src/` file in
[`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio)
(the private repo this fork's parent detour lives in), at commit:

```
12ce58414ad0f8f1e34c581d7583e6998e05e8bb
```

`git rev-parse HEAD` in that repo, run on the `feat/shopping-list-wowsims-tab`
branch, 2026-08-14.

This file is the compensating control named in `docs/plans/wowsims-tab/plan.md`
§8 ("E-W3 runs here, not in the fork"): the hash column is what
`scripts/check_engine_port_drift.py` (in the `tbc-gear-prio` repo) re-derives
and compares on every `pnpm verify`. **A hash match proves the file's bytes
have not changed since this table was written — nothing about behaviour.**
Only the parity test (E-W3, `packages/core/test/wowsims-fork-parity.test.ts`)
proves behaviour is unchanged.

## Two rows trace to a later core commit than the header

`dead-slots.ts` and `plausibility.ts` carry a source-commit note in their
label column: they trace to core `2e6b257` ("Mark worn-unrankable slots
instead of showing false losses"), which is **not** an ancestor of the header
commit above:

```
git merge-base --is-ancestor 2e6b257 12ce58414ad0f8f1e34c581d7583e6998e05e8bb   && echo ancestor || echo "not an ancestor"
```

The `worn-unrankable` feature landed in core after this table was written, so
the two files sat stale while their "none (import paths only)" labels stayed
literally accurate for the commit they were compared against — which is why
neither gate could see it (ticket 214). The port was applied 2026-08-17 and
both files now show zero comment-stripped code divergence from their core
sources.

The header commit is stale for **every** row, not just these two. Re-baselining
the whole table is deliberately not done here: it would assert a fresh
comparison for 31 rows nobody re-verified in this round. Recorded as an open
observation on ticket 214 instead.

## Racing removed 2026-08-22

`rank.ts`, `view.ts` and `content-hash.ts` (doc comment only) no longer carry
candidate-pool.md M2's racing pass, and `promotion.ts` is deleted — its row is
gone from the table below, because the drift script reports a listed file that
is absent as `missing:` and fails.

Ported from core commit `28b00f9` ("Remove racing; full-sweep every eligible
candidate"), the change ADR-0026 records; the ADR itself was written in
`66dab19`. That commit is **later than this file's header commit** and not an
ancestor of it:

```
git merge-base --is-ancestor 28b00f9 12ce58414ad0f8f1e34c581d7583e6998e05e8bb
# exit 1 — not an ancestor
```

`rank.ts` was **not** re-ported from core. The removal was done in place, so
the fork keeps its three deliberate adaptations (`canonicalJson` hashing, no
`spec.ts`, `simDatabaseFor` threading). Two divergences from core survive on
purpose and must not be "fixed" by copying core's file: the cache payload
freezes three racing fields where core freezes four (no `promoteTopJ`, which
the fork never hashed — adding it would change every key already written), and
`candidateCap` is hashed as `?? ordered.length` where core omits it when
undefined. Compare the two files by hand, not with `diff -w`.

E-W3 (`packages/core/test/wowsims-fork-parity.test.ts`) passed against the
de-raced engine before these hashes were written, which is the order this
file's own rule requires.

## A CRLF trap in this clone

This fork clone has `core.autocrlf=true` (`git -C vendor/tbc-new-fork config
core.autocrlf`) while the main `tbc-gear-prio` repo has it `false`, so a
file's bytes on disk here carry CRLF line endings even though the git blob
stores LF. `scripts/check_engine_port_drift.py` hashes raw bytes on disk
(`sha256_of`), so a file that is otherwise byte-identical to its ported
source still reports "drifted" for line-ending reasons alone.

Confirmed for `disclosure.ts` and `set-value.ts` as of the candidate-pool
M1 port round (2026-08-15): both are CRLF on disk, and `tr -d '\r' <
disclosure.ts | sha256sum` (respectively `set-value.ts`) reproduced this
table's recorded hash exactly — content-identical, drift is line-endings
only. Neither file was touched by that round.

**No longer true of `set-value.ts` as of the batch-sim fix round
(2026-09-01):** it has a doc comment core does not have, describing an
invariant that only matters where a bulk screening pass exists. Its row is
adapted rather than byte-identical, and its recorded hash is the CRLF
on-disk value like every other row. The paragraph above still describes
`disclosure.ts`. Recorded here rather than
"fixed" by rewriting their hashes to the CRLF-on-disk value, because a
hash rewritten without re-running E-W3 first is exactly the silent-drift
scenario this file exists to prevent (see the check script's own reminder)
— and the CRLF issue applies to *every* ported file at read time, not just
these two, so a global normalization decision belongs to whoever owns this
clone's line-ending policy, not to a single porting round.

**The trap also bites freshly-added files, demonstrated live in this same
round.** `candidate-order.ts` and `promise-pool.ts` were created with LF
line endings (via a tool that writes files as-is) and hashed correctly at
that point. After `git commit` + `git checkout feat/upgrades-tab` + `git
merge` — ordinary operations, no editing — `core.autocrlf=true` silently
rewrote both to CRLF on disk, and the drift check then reported them as
drifted too, purely from that checkout. `tr -d '\r'` on each again
reproduced the exact hash recorded at LF-creation time, confirming
content was never touched. **This means the hash recorded in this table
at any given moment reflects whichever line-ending state the file
happened to be in on disk when the hash was computed, not a stable
property of the file's content** — the gate as currently specified
(`sha256_of` on raw disk bytes, `scripts/check_engine_port_drift.py`) is
unpassable across a `git checkout`/`merge` cycle on this clone regardless
of what a porting round does, until either this clone sets
`core.autocrlf=false` (or `.gitattributes` pins `engine/**/*.ts text
eol=lf`) or the check script normalizes line endings before hashing.
Recorded here as measured fact, not fixed by this round — the fix is a
clone/repo-configuration decision outside a single slice's scope.

## How to read "Adaptation"

- **none** — byte-for-byte port apart from import paths.
- **adapted** — same logic, retargeted at a different data source or API;
  the file's own doc comment explains the change in full.
- **not ported** — listed for completeness; plan §2.1 excludes it and the
  reason is in plan §2.1 or in the substituting file's own doc comment.

## Ported files

| Fork file | Source (`packages/core/src/`) | Adaptation | sha256 |
|---|---|---|---|
| `types.ts` | `types.ts` | none | `a4940cedec5a23d7794e2779044a1ba0bdaa6a59da17ee4040dbfee929a323a8` |
| `cap-profile.ts` | `cap-profile.ts` | none | `dcd21e8812d7a18ad77cdc174245ef991f65daae62622f9304982f9e12b8e145` |
| `slots.ts` | `slots.ts` (SIM_ORDER only) + `slots-sim-order.generated.ts` | adapted — hand-written literal, WCL_ORDER/mapWclGearToSim dropped | `54d51dcdf27b6a25cce19c8908ce60fdcf5b163c56c313d75ebb5f74b2078c34` |
| `stats.ts` | `stats.ts` | adapted — `Stat` from fork's own generated proto | `2cbb61e565dc1cfe66c18ae590e7683c97a0ab41e22c6fec89ad053662e499af` |
| `cutoff.ts` | `cutoff.ts` | none | `c129f598e4ab58de8bb76dd256e497a0e27fbb9ddc31da3d143bf8dc098ed9b6` |
| `se.ts` | `se.ts` | none | `2c03b1a318c23600d55568a4acf00a0698802135ece833e0c9d5ddb855bc9540` |
| `kael-temp.ts` | `kael-temp.ts` | none | `945180888a3d8fc18f361f2efa1d6952a86da52c3f18169c3facd5916843fe4e` |
| `items.ts` | `items.ts` | adapted — Database-backed, not JSON-backed (plan §2.1) | `92000b125b8b0e3a044d1abf692509cc436c85134d276e5257d22a633b8c46e0` |
| `enchants.ts` | `enchants.ts` | adapted — bridges to fork's own upstream `enchantAppliesToItem` | `b1252c3083caa588befaa0065d3f9e44339893c0be46cbc802461cd803caf3c8` |
| `gems.ts` | `gems.ts` | adapted — Database-backed, not JSON-backed | `1f86359ce67ae36d6d5902393f01961ea5e25587ff5ca809d9429166a9483871` |
| `meta.ts` | `meta.ts` | adapted — reuses fork's own `MetaGemCondition`/`gemColorMatchesSocket` | `b28d44432f0f64581447c221fdc3b44cc118ff6affa76b39808cf713d3018565` |
| `migrate-gems.ts` | `migrate-gems.ts` | none (import paths only) | `080b49441ee61f0b9129dc42d5d90703726e16efec653f9082b04bf8d0c102c5` |
| `candidate-gems.ts` | `candidate-gems.ts` | none (import paths only) | `b815496bb690275c965526736e219b0b281f4c45667a5b5c04b45a34f95b2c48` |
| `meta-repair.ts` | `meta-repair.ts` | none (import paths only) | `a044d76707ba1e0be9f54d62bb7d9db384c1f30b15e35eb484d6afb991bcd4ad` |
| `set-bonus.ts` | `set-bonus.ts` | none (import paths only) | `44d6cd77247fff7b87f21b3716b7bb21305d24ab2f002d98706c4c6286d2fe09` |
| `set-value.ts` | `set-value.ts` | adapted — import paths, plus a doc comment on `IndividualDelta` stating the invariant `computeSynergy` depends on: `deltaDps` must estimate the item's own DPS effect (candidate minus baseline from the same run), which a same-run delta satisfies automatically — including one measured by the fork's bulk screening pass against that pass's own probe. Comment only; no behaviour change, and core has no bulk path for the note to apply to | `8a3add40179c7ab6a4fb99030e8bd90bf9a4d342962b9c0ab4fc19cc26189386` |
| `dead-slots.ts` | `dead-slots.ts` | none (import paths only); traces to core `2e6b257`, not the header commit | `c6b5957ae1877407dcfe52ea4bd284120ed8b0c5cc6c3e66c90b0e361ad027bb` |
| `pool.ts` | `pool.ts` | adapted — hand-written `ItemSlot`/`ITEM_SOURCE_KINDS` literals, not generated | `8c18ebdf1ddd255ed1b84ac961b41e741a67e091edb16734108a9ef18a595271` |
| `logged-gear.ts` | `logged-gear.ts` | none (import paths only) | `db249cfaddf1e98c7a87d8043ed724e5c7973f9f0a196de0c43c6f95308848aa` |
| `caps.ts` | `caps.ts` | none (import paths only) | `0ec70b7591f0175b6e83127e7313d20278f91dbb529336a88bd320559e11945c` |
| `compose.ts` | `compose.ts` | none | `d04664377dfee70476b9f5e566be1fd310638dcf55f2d4d3ae0724180dd13c98` |
| `content-hash.ts` | `content-hash.ts` | adapted — `canonicalJson` only, no `sha256Hex`/`node:crypto` (D4); racing's hash fields are frozen literals at `rank.ts`'s `canonicalJson(...)` call site, not in this file (ADR-0026) | `41df9a9547cdeb5bff40815c3e82e8998fb96e38173c8494566981db69c2af26` |
| `disclosure.ts` | `disclosure.ts` | none | `0c2b09ca67dcf237d7de3fd8962181278fc9b6eea24f877c1f1386dc96a56b6d` |
| `plausibility.ts` | `plausibility.ts` | none (import paths only); traces to core `2e6b257`, not the header commit | `806dc7bde5d7af33171d462d49809b501d29f3edf696bbd333697db994e4023d` |
| `view.ts` | `view.ts` | adapted — inlines `setPotentialIsConfounded` instead of importing `rank-report-rules.ts` (out of scope) | `d0f55b20040204b73bf90d43ee5df5b325d2905f4520928b70467757f34354d5` |
| `rank.ts` | `rank.ts` | adapted — drops spec-mismatch check (`spec.ts` not ported); cache key is `canonicalJson(...)` not `contentHashOf(...)` (D4); candidate-pool.md M1 (cap, concurrency, EP ordering, Stop/`complete`, row events) ported unchanged; racing removed in place (core `28b00f9` / ADR-0026), so M2's screen/promote pass, `screenCandidate`, the `screening` progress stage and `screeningSkips` are gone; the cache payload keeps the three frozen racing literals (`fullPool: true`, `screenIterations: null`, `promoteTopK: null`) and no `promoteTopJ` — deliberate divergence from core's four; ticket 212's `simDatabaseFor` threading ported in core's post-`ea8f916` form (one `compose(deps.raidSimSkeleton` call, inside a single `composeFor` closure that all four compose sites call; `buildSetBonuses` takes `composeFor` as a parameter rather than resolving a database of its own); `PRESET_ID_BY_SPEC` values stay the fork's `<spec>/current-page-settings` labels rather than core's file paths, because the skeleton comes from the page and no such file exists here; `DEFAULT_ITERATIONS` is 5000 here (core: 3000), and a bulk screening branch (`screenCandidates`/`screenKey`) prices each (item, slot) attempt through the seam's optional `runBulkScreen` when a runner offers it — fork-only, no core ancestor. The per-candidate loop still composes every request and populates `winningRequests`/`individualDeltasByItemId`/`candidateSkips` and every row field unchanged, so only the screening DPS observation changes route; paired-seed replication and the set-bonus sims are untouched. `composeForBulk` widens the screening request's embedded `SimDatabase` to the union over the baseline and every screened gear set — one bulk request spans n gear sets while the WASM item registry is filled per request, so a baseline-only database panics on the first unworn candidate id (ticket 212's failure mode). A screened row's delta is taken against the **screening pass's own baseline**, not the loop's: the pass probes its own baseline at a seed it picks itself, and the two probes were measured 65.3 DPS apart against a 3.4 cutoff (a seed artifact — the ledger has the loop at seed 777 within 0.3 DPS of it — but the size is what the engine must handle), so `screenCandidates` returns `{ baselineDps, byKey }` and `BestSwap` records the baseline its delta was measured from, which `deltaPct` then divides by. `individualDeltasByItemId` stores that delta **unmodified**: a same-run delta already estimates the item's own effect, so re-scaling it onto the loop's baseline would inject the gap into `computeSynergy`'s `bonusDps` once per added piece rather than remove it. Screened observations are cached under a `screen:`-prefixed key rather than the loop's `sim:` key, so a bulk-measured number can never be read back by the per-candidate loop or by paired replication. The slot guards shared by the screening pass and the pricing loop are one `attemptEligibility` function, so the two routes cannot drift about which attempts exist. Ticket 347 threads `deps.signal` into the screening request, so a Stop aborts the in-flight chunk rather than waiting it out, and `screenCandidates` classifies what comes back: `BulkScreenAbortedError` is an abort (no screening numbers, and the loop dispatches nothing either), `BulkScreenIntegrityError` is rethrown so a structurally wrong bulk response is reported, and every other failure — engine-reported or transport — degrades to the per-candidate loop and is disclosed as `Ranking.screeningFallbacks` (absent when empty, so a clean bulk run stays byte-identical to a no-bulk one). Chunk-level `failures` on a successful result are disclosed the same way; ticket 350: `candidateSwapWithRepairs` clears the worn off hand for a two-handed main-hand candidate and returns it as `removed`, reported as `RankedItem.removedItems` — ported unchanged from core | `7b29da5ca3b31326074389c58ddb481d8dad8225c51a522aed609aeec7c626ac` |
| `candidate-order.ts` | `candidate-order.ts` | none (import paths only) | `251255f863487bc4c54ae949f3afd8ef9fb94bb4a100ea0d65bc14f0620ea491` |
| `promise-pool.ts` | `promise-pool.ts` | none | `d44bbc3c95539a91c1969021a945f34a3ece02f98b4495b5b7e76a3093ba4438` |
| `seams/gear-source.ts` | `seams/gear-source.ts` | none | `085d3a088a19aa5b8a28db6a2f219df6d0b44ecb39a42568c9788a21e7137cfe` |
| `seams/sim-runner.ts` | `seams/sim-runner.ts` | adapted — cache key is canonical-JSON string, no `node:crypto` (D4); adds the optional bulk screening capability (`runBulkScreen?`, `BulkScreenCandidate`/`BulkScreenRequest`/`BulkScreenResult`, `bulkScreenCacheKey`) and `RecordedSimRunner`'s bulk-recordings replay — fork-only, no core ancestor, stated in protojson vocabulary so the engine stays proto-unaware. `BulkScreenRequest` includes an explicit `seed`, threaded from the caller's `SimRunOpts.seed` rather than defaulted inside the request builder, and `bulkScreenCacheKey` includes it so the same batch at two seeds cannot collide on one recording. Ticket 347 adds `BulkScreenRequest.signal?` (the caller's Stop; a runner aborts the in-flight chunk and issues no further one), `BulkScreenResult.failures?` (chunks that failed for an engine or transport reason, whose candidates the caller sims itself), and two error classes — `BulkScreenAbortedError` and `BulkScreenIntegrityError`. Both classes live in the seam rather than beside the adapter code that throws them, because `rank.ts` tests them with `instanceof` and the engine may not import from `adapters/` | `76570b0a2b6c687858de9402d98872291736397b5e155f77268715f587efcde3` |
| `seams/store.ts` | `seams/store.ts` | adapted — `MemoryStore` only, `SqliteStore` dropped (plan §2.1) | `7e51dcf01e3118691b1e509299763dcb9f06b7ffe18314a9f5d6e6f4734c8518` |
| `fixtures/report-events-offline.ts` | `fixtures/report-events-offline.ts` | adapted — inlines `WCL_ORDER`/`mapWclGearToSim` (slots.ts's non-ported half) since the raw fixture itself is WCL-shaped | `33103fe314eba57fadfd98d6aac78d9b5a27cbcfb30c9bde702b3a822db935bd` |
| `fixtures/slamaltman-offline.ts` | `fixtures/slamaltman-offline.ts` | none (import paths only) | `60242daa975ba3ab585d9f8fa41710233173110de82ff65ebb6619022d124227` |

## Not ported (plan §2.1)

| `packages/core/src/` file | Why not |
|---|---|
| `spec.ts` | The page *is* a spec — `PlayerGearSource` (slice 3) reads the page's own current gear under its own selected spec, so there is no talent-classification step to run and nothing to refuse a mismatch against. |
| `slots.ts` (`WCL_ORDER`/`mapWclGearToSim` half) | The page's `Gear` is already sim-native; no 19→17 WCL translation needed on this surface. (The fixture loader still needs it for the raw WCL capture — see `fixtures/report-events-offline.ts`'s adaptation note, where it is inlined locally.) |
| `cli.ts`, `seams/cli-sim-runner.ts` | CLI entry points; the fork has no CLI. |
| `seams/store.ts`'s `SqliteStore` half | No `node:sqlite` in the browser. |
| `content-hash.ts`'s `sha256Hex`/`contentHashOf`/`node:crypto` half | D4: cache keys need uniqueness, not a digest; the browser has no `node:crypto`. |
| `items.ts`'s 6.8 MB static `data/items/index.json` index | The fork's own `Database` (`sim.db`) already holds this; see `items.ts`'s adaptation. |
| `enchants.ts`'s `data/enchants/index.json` snapshot | The fork's own `ui/core/proto_utils/utils.ts` already exports a live-Database-backed `enchantAppliesToItem`; re-deriving a second copy would itself be the kind of drift plan §3 warns about. |
| `rank-report.ts`, `rank-report-rules.ts`, `rank-report-css.ts` | CLI/HTML report renderer; the fork's tab is its own renderer (slice 4), not a consumer of packages/core's HTML report. One pure predicate (`setPotentialIsConfounded`) is inlined into `view.ts` rather than pulling in the whole module — see that file's doc comment. |

## Data files copied into the fork (plan §2.5)

Not yet done as of this port (slice 2 scope is the `engine/` code surface;
universe/EP-weight data copying is deferred to slice 3, where the adapters
that consume them are built). Recorded here so the gap is visible rather than
silently assumed:

- `data/universes/<spec>-p<N>.json` — **not yet copied**.
- `data/presets/<spec>/p<N>.ep-weights.json` — **not yet copied**.
