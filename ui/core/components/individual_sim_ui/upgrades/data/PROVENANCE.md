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
| `balance-p2.universe.json` | `data/universes/balance-p2.json` |
| `balance-p3.universe.json` | `data/universes/balance-p3.json` |
| `balance-p4.universe.json` | `data/universes/balance-p4.json` |
| `balance-p5.universe.json` | `data/universes/balance-p5.json` |
| `hunter-p2.universe.json` | `data/universes/hunter-p2.json` |
| `hunter-p3.universe.json` | `data/universes/hunter-p3.json` |
| `hunter-p4.universe.json` | `data/universes/hunter-p4.json` |
| `hunter-p5.universe.json` | `data/universes/hunter-p5.json` |
| `mage-p2.universe.json` | `data/universes/mage-p2.json` |
| `mage-p3.universe.json` | `data/universes/mage-p3.json` |
| `mage-p4.universe.json` | `data/universes/mage-p4.json` |
| `mage-p5.universe.json` | `data/universes/mage-p5.json` |
| `shadow-p2.universe.json` | `data/universes/shadow-p2.json` |
| `shadow-p3.universe.json` | `data/universes/shadow-p3.json` |
| `shadow-p4.universe.json` | `data/universes/shadow-p4.json` |
| `shadow-p5.universe.json` | `data/universes/shadow-p5.json` |
| `rogue-p2.universe.json` | `data/universes/rogue-p2.json` |
| `rogue-p3.universe.json` | `data/universes/rogue-p3.json` |
| `rogue-p4.universe.json` | `data/universes/rogue-p4.json` |
| `rogue-p5.universe.json` | `data/universes/rogue-p5.json` |
| `ele-p2.universe.json` | `data/universes/ele-p2.json` |
| `ele-p3.universe.json` | `data/universes/ele-p3.json` |
| `ele-p4.universe.json` | `data/universes/ele-p4.json` |
| `ele-p5.universe.json` | `data/universes/ele-p5.json` |
| `enh-p2.universe.json` | `data/universes/enh-p2.json` |
| `enh-p3.universe.json` | `data/universes/enh-p3.json` |
| `enh-p4.universe.json` | `data/universes/enh-p4.json` |
| `enh-p5.universe.json` | `data/universes/enh-p5.json` |
| `warlock-p2.universe.json` | `data/universes/warlock-p2.json` |
| `warlock-p3.universe.json` | `data/universes/warlock-p3.json` |
| `warlock-p4.universe.json` | `data/universes/warlock-p4.json` |
| `warlock-p5.universe.json` | `data/universes/warlock-p5.json` |
| `warrior-p2.universe.json` | `data/universes/warrior-p2.json` |
| `warrior-p3.universe.json` | `data/universes/warrior-p3.json` |
| `warrior-p4.universe.json` | `data/universes/warrior-p4.json` |
| `warrior-p5.universe.json` | `data/universes/warrior-p5.json` |
| `feral-p4.universe.json` | `data/universes/feral-p4.json` |
| `feral-p5.universe.json` | `data/universes/feral-p5.json` |
| `balance-fallback.ep-weights.json` | `data/presets/balance/fallback.ep-weights.json` |
| `balance-p1.ep-weights.json` | `data/presets/balance/p1.ep-weights.json` |
| `balance-p2.ep-weights.json` | `data/presets/balance/p2.ep-weights.json` |
| `balance-p3.ep-weights.json` | `data/presets/balance/p3.ep-weights.json` |
| `balance-p4.ep-weights.json` | `data/presets/balance/p4.ep-weights.json` |
| `hunter-fallback.ep-weights.json` | `data/presets/hunter/fallback.ep-weights.json` |
| `mage-fallback.ep-weights.json` | `data/presets/mage/fallback.ep-weights.json` |
| `mage-p2.ep-weights.json` | `data/presets/mage/p2.ep-weights.json` |
| `shadow-fallback.ep-weights.json` | `data/presets/shadow/fallback.ep-weights.json` |
| `shadow-p3.ep-weights.json` | `data/presets/shadow/p3.ep-weights.json` |
| `rogue-fallback.ep-weights.json` | `data/presets/rogue/fallback.ep-weights.json` |
| `ele-fallback.ep-weights.json` | `data/presets/ele/fallback.ep-weights.json` |
| `enh-fallback.ep-weights.json` | `data/presets/enh/fallback.ep-weights.json` |
| `enh-p3.ep-weights.json` | `data/presets/enh/p3.ep-weights.json` |
| `warlock-fallback.ep-weights.json` | `data/presets/warlock/fallback.ep-weights.json` |
| `warrior-fallback.ep-weights.json` | `data/presets/warrior/fallback.ep-weights.json` |
| `warrior-p2.ep-weights.json` | `data/presets/warrior/p2.ep-weights.json` |

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

## Refresh, 2026-08-23 (ticket 211 closes)

They drifted again, exactly as the 2026-08-16 note predicted. Five of the
eight copies were stale; `ret-p2.universe.json` and both EP-weight files
still matched. Two upstream commits in `dgreenberggit/tbc-gear-prio` explain
every one of the five, and each file below is attributed to its cause:

| Fork file | Delta vs its source | Cause |
|---|---|---|
| `ret-p3.universe.json` | 1 local-only: 29297 | `5cf0ea0` |
| `ret-p4.universe.json` | 1 local-only: 29297 | `5cf0ea0` |
| `ret-p5.universe.json` | 2 local-only: 29297, 34470 | `5cf0ea0` |
| `feral-p2.universe.json` | 18 fork-only weapon rows | `5c42a37` |
| `feral-p3.universe.json` | 33 fork-only weapon rows; 1 local-only: 29297 | `5c42a37` (removals) + `5cf0ea0` (29297) |

- `5cf0ea0` "Ship Band of the Eternal Defender, now that the sim implements
  it" admits Band of the Eternal Defender (29297) to ret-p3, ret-p4, ret-p5
  and feral-p3, and Timbal's Focusing Crystal (34470, phase 5) to ret-p5.
  The stale copies were **missing** those rings, so the tab could not rank
  them.
- `5c42a37` "Exclude weapon types a druid cannot equip" removes
  druid-unusable weapon rows from the feral universes (18 from p2, 33 from
  p3). The stale copies still **contained** them, so the tab was offering a
  feral player weapons a druid cannot equip.

No shared entry differed in content in any of the five files -- this drift
was membership only.

**Resolved:** `scripts/sync_fork_universes.py` in the source repo now owns
the mechanism the last refresh left open. `pnpm fork-universes:check` runs
in that repo's `pnpm verify` and byte-compares every row of the mapping
table above; `python scripts/sync_fork_universes.py --write` is the
one-command refresh. Run from the source repo:

```bash
python scripts/sync_fork_universes.py --check
```

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

## Refresh, 2026-08-25 (equip legality borrowed from `canEquipItem`)

28 of the 63 copies drifted, caught by `pnpm fork-universes:check` and
refreshed with `python scripts/sync_fork_universes.py --write`. One upstream
change explains all 28: the source repo stopped re-implementing this fork's
equip rules in Python and now consumes `canEquipItem`'s own answer, exported
by `upgrades/tools/export_equip_eligibility.mts` in this fork.

| Fork files | Delta vs source | Cause |
|---|---|---|
| `ret-p2/p3/p4/p5` | 48/76/85/97 local-only, all cloth armor | Ret's pool no longer filters by armor class |
| `feral-p2/p3/p4/p5` | 1/2/3/5 fork-only | Off-hand-only fist weapons a druid cannot dual-wield |
| `balance-p2/p3/p4/p5` | 6/7/8/14 fork-only | Same off-hand rule |
| `ele-p2/p3/p4/p5` | 6/7/8/14 fork-only | Same off-hand rule |
| `mage`, `shadow`, `warlock` p2-p5 | 1/1/1/3 fork-only each | Same off-hand rule |

Two kinds of change, both deliberate:

- **Removals (99 rows across 24 files) are a correctness fix.** Every one is
  an off-hand-only weapon (proto `HandTypeOffHand = 3`) held by a spec that
  cannot dual-wield. The Python mirror had no off-hand check at all, so the
  stale copies were offering weapons the sim's own gear picker refuses — the
  same failure class as the rogue two-handed sword in ticket 301. Off-hand
  *frills* (`WeaponTypeOffHand`) are unaffected and stay in: any class may
  hold one.
- **Additions (306 rows, ret only) are a ruled policy change.** A paladin can
  equip cloth, and every other spec's pool already admitted it — warrior, the
  other plate class, ships 177 cloth pieces at p5. Ret's omission was an
  unexplained outlier, ruled so by the SME gate for this branch. Ret keeps its
  two-hander-only weapon rule, which survives as a *named* policy exclusion
  rather than as an equip rule.

No shared entry differed in content in any of the 28 files — membership only.

## Refresh, 2026-08-25 (ret policy note corrected)

`ret-p2/p3/p4/p5.universe.json` only, and **text only — no membership change**
(`0 local-only; 0 fork-only; 0 shared entries differ in content`; the delta is
the payload's `d7Note` string).

Pre-merge review found two defects in the same note:

- The generator published a policy justification only for a weapon-type
  exclusion, so ret's two-hander rule — which is a hand-type rule — shipped its
  mandatory note silently. A reader of the artifact could not learn why the
  one-handers were missing. `scripts/check_policy_notes.py` now pins each
  policy kind separately.
- The note cited "Bulwark of Azzinoth (id 28593)". 28593 is Eternium Greathelm,
  a plate helm that is legitimately **in** ret's pool; Bulwark of Azzinoth is
  32375. The example named an included item as an excluded one.
