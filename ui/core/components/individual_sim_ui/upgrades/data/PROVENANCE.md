# Data copy provenance

Plan §2.5: "universe/EP-weight data copied into the fork" — deferred by
slice 2 (`engine/PROVENANCE.md`'s own "Data files copied into the fork"
section), done here in slice 3, the first slice that has a consumer for it
(`data.ts` in this directory).

Copied verbatim (byte-for-byte, no field rewriting) from
[`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio),
`feat/shopping-list-wowsims-tab`. Universes originally copied at commit
`8730a1cf`, **refreshed 2026-08-16 from `60e05571`** (see "Refresh" below);
the two EP-weight files are unchanged since `8730a1cf` and were verified
identical to their sources at the refresh.

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

## Refresh, 2026-08-16 (ticket 211)

**Nothing regenerates these copies, so they went stale and nothing noticed.**
By 2026-08-16 every one of the six universes had drifted from its source —
ret-p5 by 28 items, and on ret-p3 alone 300 of 384 shared entries differed in
content (`curationHint` values had been rescored). The copies also predated
`epWeights` provenance being stamped into the artifacts, so that key was
missing entirely.

Two upstream commits explain the membership half, and both are deliberate
decisions the stale copies were silently reverting:

- `c718d38` force-admits six SME-flagged ret librams and trinkets (Darkmoon
  Card: Crusade, Hourglass of the Unraveller, Abacus of Violent Odds, and
  three librams). The stale copies were **missing** all six, so the tab could
  not rank them at all.
- `1fcfcaf` drops stub-only sim effects per ticket 171's user ruling — an item
  whose only sim effect is a `TODO: Manual implementation required` stub must
  not appear in any pool. The stale copies still **contained** those items, so
  the tab was offering candidates the ruling excluded by design.

Refreshed by straight copy from `data/universes/*.json` at `60e05571`; all six
now compare `==` to their sources under `json.load`. Re-runnable check:

```bash
python -c "
import json
for f in ['ret-p2','ret-p3','ret-p4','ret-p5','feral-p2','feral-p3']:
    a=json.load(open(f'data/universes/{f}.json',encoding='utf-8'))
    b=json.load(open(f'vendor/tbc-new-fork/ui/core/components/individual_sim_ui/upgrades/data/{f}.universe.json',encoding='utf-8'))
    print(f, a==b)
"
```

`data.ts` reads only `entries` (its `RawUniverse` type), so the newly present
`epWeights` key is inert; `npm run type-check` and this repo's full suite
(832 tests, including E-W3) pass after the refresh.

**Unresolved:** there is still no automated check that these copies match, so
they can drift again the moment a universe is regenerated. Ticket 211 owns
that; this refresh fixes the data, not the mechanism.

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
