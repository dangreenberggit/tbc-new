# Data copy provenance

Plan §2.5: "universe/EP-weight data copied into the fork" — deferred by
slice 2 (`engine/PROVENANCE.md`'s own "Data files copied into the fork"
section), done here in slice 3, the first slice that has a consumer for it
(`data.ts` in this directory).

Copied verbatim (byte-for-byte, no field rewriting) from
[`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio),
commit `8730a1cfcacd552a1869d0cedad914a93170e9c6`, `feat/shopping-list-wowsims-tab`:

| Fork file | Source |
|---|---|
| `ret-p2.universe.json` | `data/universes/ret-p2.json` |
| `ret-p3.universe.json` | `data/universes/ret-p3.json` |
| `ret-p4.universe.json` | `data/universes/ret-p4.json` |
| `ret-p5.universe.json` | `data/universes/ret-p5.json` |
| `feral-p2.universe.json` | `data/universes/feral-p2.json` |
| `feral-p3.universe.json` | `data/universes/feral-p3.json` |
| `ret-p2.ep-weights.json` | `data/presets/ret/p2.ep-weights.json` |
| `feral-p1.ep-weights.json` | `data/presets/feral/p1.ep-weights.json` |

## Known staleness, carried over rather than fixed here

- **Ret only has EP weights at p2.** Plan §7 flags this: "ret p3 rankings
  with p2 weights are *usable but degraded*" — EP only drives the prefilter
  and gem fill (sims produce every ranking number), so a p3/p4/p5 run uses
  `ret-p2.ep-weights.json` for that role until slice 6 lands a p3 set.
  `data.ts` makes this explicit rather than silently reusing the file with
  no comment.
- **Ret p3-p5 `bisTags` trace to p2-era membership**, per plan §7 — wowsims
  had no ret p3 curated set at the time these universes were assembled.
  Slice 6 (`docs/plans/wowsims-tab/orchestration.md`: "PARKED at data done,
  review pending") is the refresh; not done in this slice.
- **Feral has no p1 universe file** — only `feral-p2.universe.json` and
  `feral-p3.universe.json` exist upstream in this repo, but the EP weights
  file is `p1.ep-weights.json` (upstream ships exactly one feral EP preset,
  named P1 — see that file's own `notes`). `data.ts` uses the p1 EP weights
  for every feral phase, same "usable but degraded" reasoning as ret's p2
  weights covering p3-p5.

No field-level transformation was applied to any file — `poolFromUniverse`
(`engine/pool.ts`) and `epScore`/`EpWeights` (`engine/stats.ts`) already
accept these shapes unchanged, confirmed by reading both source files
against the copied JSON before writing `data.ts`.
