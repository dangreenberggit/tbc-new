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

## A CRLF trap in this clone

This fork clone has `core.autocrlf=true` (`git -C vendor/tbc-new-fork config
core.autocrlf`) while the main `tbc-gear-prio` repo has it `false`, so a
file's bytes on disk here carry CRLF line endings even though the git blob
stores LF. `scripts/check_engine_port_drift.py` hashes raw bytes on disk
(`sha256_of`), so a file that is otherwise byte-identical to its ported
source still reports "drifted" for line-ending reasons alone.

Confirmed for `disclosure.ts` and `set-value.ts` as of the candidate-pool
M1 port round (2026-08-15): both are CRLF on disk, and `tr -d '\r' <
disclosure.ts | sha256sum` (respectively `set-value.ts`) reproduces this
table's recorded hash exactly — content-identical, drift is line-endings
only. Neither file was touched by that round. Recorded here rather than
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
- **adapted** — same logic, retargeted at a different data source or API
  shape; the file's own doc comment explains the change in full.
- **not ported** — listed for completeness; plan §2.1 excludes it and the
  reason is in plan §2.1 or in the substituting file's own doc comment.

## Ported files

| Fork file | Source (`packages/core/src/`) | Adaptation | sha256 |
|---|---|---|---|
| `types.ts` | `types.ts` | none (narrowed doc comment only) | `e23454dacccd7bb154b461a65d866fafb7dbd1d04e3eb1107b999b4bafb5adf7` |
| `slots.ts` | `slots.ts` (SIM_ORDER only) + `slots-sim-order.generated.ts` | adapted — hand-written literal, WCL_ORDER/mapWclGearToSim dropped | `54d51dcdf27b6a25cce19c8908ce60fdcf5b163c56c313d75ebb5f74b2078c34` |
| `stats.ts` | `stats.ts` | adapted — `Stat` from fork's own generated proto | `2cbb61e565dc1cfe66c18ae590e7683c97a0ab41e22c6fec89ad053662e499af` |
| `cutoff.ts` | `cutoff.ts` | none | `806d9bb1383950074da3bcc4b245c9a6180083a39a0a37413131cf53bdc8edc9` |
| `se.ts` | `se.ts` | none | `2c03b1a318c23600d55568a4acf00a0698802135ece833e0c9d5ddb855bc9540` |
| `kael-temp.ts` | `kael-temp.ts` | none | `945180888a3d8fc18f361f2efa1d6952a86da52c3f18169c3facd5916843fe4e` |
| `items.ts` | `items.ts` | adapted — Database-backed, not JSON-backed (plan §2.1) | `bd6788a87a54afcce7b8c77aede395e39399b8a4d86def0e8e0bfc69f8ecedd4` |
| `enchants.ts` | `enchants.ts` | adapted — bridges to fork's own upstream `enchantAppliesToItem` | `f134b35f53ba3cb8d7d38dcffb84488ab510c3c2a1763f51f346295a629a1737` |
| `gems.ts` | `gems.ts` | adapted — Database-backed, not JSON-backed | `0899adb651c2cbac93eb8ecfb50ed66b2649518683fa9d442dd05cf2b84ba58c` |
| `meta.ts` | `meta.ts` | adapted — reuses fork's own `MetaGemCondition`/`gemColorMatchesSocket` | `3b6010347c3c86b16490fbc6abfa4346c291b2bbb49d1f0057af312f0f6213cf` |
| `migrate-gems.ts` | `migrate-gems.ts` | none (import paths only) | `b46f39a410eb07af3768047fc79c8ce98ca2c331d18d6324f4393cef241547f2` |
| `candidate-gems.ts` | `candidate-gems.ts` | none (import paths only) | `9bf16a4243bd20748b78167b1e27efcc2f5b1967ebcba84fc1accf695bd1332e` |
| `meta-repair.ts` | `meta-repair.ts` | none (import paths only) | `2c7fd7dd705f8173a0c813cb573bfb904d5870d5cd665c605068782b23e09777` |
| `set-bonus.ts` | `set-bonus.ts` | none (import paths only) | `44d6cd77247fff7b87f21b3716b7bb21305d24ab2f002d98706c4c6286d2fe09` |
| `set-value.ts` | `set-value.ts` | none (import paths only) | `317f07056e02038a70f9594606300e1d1b9189d321cdc873c3f1fa1c6cf0b270` |
| `dead-slots.ts` | `dead-slots.ts` | none (import paths only) | `f141d194686dc1f70e6afe60b40445e505c6ea4c6ffdd4a7711365613c260ae9` |
| `pool.ts` | `pool.ts` | adapted — hand-written `ItemSlot`/`ITEM_SOURCE_KINDS` literals, not generated | `27595bfe7abe0b852162451dff7db6e03f803b5379bd1dde0d8ac6b8a7e2e165` |
| `logged-gear.ts` | `logged-gear.ts` | none (import paths only) | `34b5bc81ae85e781625fe118c8869bec94f09c72fc573753d24b7b7063ffbc79` |
| `caps.ts` | `caps.ts` | none (import paths only) | `d785ad56ae60e4cd5af4b465a620f739ac715c7b401c741d7a943fd222369d63` |
| `compose.ts` | `compose.ts` | none | `bff06777e8338873f06746901ea24d821895ad35ca701549c2c6d6a5103f3578` |
| `content-hash.ts` | `content-hash.ts` | adapted — `canonicalJson` only, no `sha256Hex`/`node:crypto` (D4) | `a30d22bf04c59cc1c9c6692ec283c775c568161e551ce9571219f04210889b3c` |
| `disclosure.ts` | `disclosure.ts` | none | `0dec2c071c0fe56a7e37d0d07de9672a4fa076d93f30b8f5734dc05835a0a243` |
| `plausibility.ts` | `plausibility.ts` | none (import paths only) | `182f518ddda01ec9747afba7b3bf90cf1577d62fbf723fda1263b177d1651e9f` |
| `view.ts` | `view.ts` | adapted — inlines `setPotentialIsConfounded` instead of importing `rank-report-rules.ts` (out of scope) | `bd8833ac761fc4c95c109b2b1ee43188d7ee96d4bf461496f5b7bcbf70c4c45a` |
| `rank.ts` | `rank.ts` | adapted — drops spec-mismatch check (`spec.ts` not ported); cache key is `canonicalJson(...)` not `contentHashOf(...)` (D4); candidate-pool.md M1 (cap, concurrency, EP ordering, Stop/`complete`, row events) ported unchanged in shape | `14f9e40ccb284efa3d339e7214cbbcd64b446b341be24596ac586e7d9ff9868b` |
| `candidate-order.ts` | `candidate-order.ts` | none (import paths only) | `c0fb93b75f278af0b505d6c426a30aa235716949b57b48da90f9363fa732be64` |
| `promise-pool.ts` | `promise-pool.ts` | none | `de3ad049ab8b9b56ce99e27550b8e3b21a7931d3d595b0c861eb6cc3c21b2e53` |
| `seams/gear-source.ts` | `seams/gear-source.ts` | none | `085d3a088a19aa5b8a28db6a2f219df6d0b44ecb39a42568c9788a21e7137cfe` |
| `seams/sim-runner.ts` | `seams/sim-runner.ts` | adapted — cache key is canonical-JSON string, no `node:crypto` (D4) | `7540cbc3d0f03f662d937bac65669b053b1db9cae9f42f1b0a8a99c6cfd39595` |
| `seams/store.ts` | `seams/store.ts` | adapted — `MemoryStore` only, `SqliteStore` dropped (plan §2.1) | `7e51dcf01e3118691b1e509299763dcb9f06b7ffe18314a9f5d6e6f4734c8518` |
| `fixtures/report-events-offline.ts` | `fixtures/report-events-offline.ts` | adapted — inlines `WCL_ORDER`/`mapWclGearToSim` (slots.ts's non-ported half) since the raw fixture itself is WCL-shaped | `00fc0c286845445a2424b7bea73f71c2303a1ddaac7ca35332258a4c99d80df9` |
| `fixtures/slamaltman-offline.ts` | `fixtures/slamaltman-offline.ts` | none (import paths only) | `c7bb93e75193f05d63b8ecb4a62fef69be4a439936dcebc2ec7fcfc5e16eeca4` |

## Not ported (plan §2.1)

| `packages/core/src/` file | Why not |
|---|---|
| `spec.ts` | The page *is* a spec — `PlayerGearSource` (slice 3) reads the page's own current gear under its own selected spec, so there is no talent-classification step to run and nothing to refuse a mismatch against. |
| `slots.ts` (`WCL_ORDER`/`mapWclGearToSim` half) | The page's `Gear` is already sim-native; no 19→17 WCL translation needed on this surface. (The fixture loader still needs it for the raw WCL capture — see `fixtures/report-events-offline.ts`'s adaptation note, where it is inlined locally.) |
| `cli.ts`, `seams/cli-sim-runner.ts` | CLI entry points; the fork has no CLI. |
| `seams/store.ts`'s `SqliteStore` half | No `node:sqlite` in the browser. |
| `content-hash.ts`'s `sha256Hex`/`contentHashOf`/`node:crypto` half | D4: cache keys need uniqueness, not a digest; the browser has no `node:crypto`. |
| `items.ts`'s 6.8 MB static `data/items/index.json` index | The fork's own `Database` (`sim.db`) already carries this; see `items.ts`'s adaptation. |
| `enchants.ts`'s `data/enchants/index.json` snapshot | The fork's own `ui/core/proto_utils/utils.ts` already exports a live-Database-backed `enchantAppliesToItem`; re-deriving a second copy would itself be the kind of drift plan §3 warns about. |
| `rank-report.ts`, `rank-report-rules.ts`, `rank-report-css.ts` | CLI/HTML report renderer; the fork's tab is its own renderer (slice 4), not a consumer of packages/core's HTML report. One pure predicate (`setPotentialIsConfounded`) is inlined into `view.ts` rather than pulling in the whole module — see that file's doc comment. |

## Data files copied into the fork (plan §2.5)

Not yet done as of this port (slice 2 scope is the `engine/` code surface;
universe/EP-weight data copying is deferred to slice 3, where the adapters
that consume them are built). Recorded here so the gap is visible rather than
silently assumed:

- `data/universes/<spec>-p<N>.json` — **not yet copied**.
- `data/presets/<spec>/p<N>.ep-weights.json` — **not yet copied**.
