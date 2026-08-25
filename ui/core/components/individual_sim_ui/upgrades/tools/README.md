# Upgrades exporters

Node scripts that run the fork's **own** decision functions and write their
answers as JSON for the outer repo
([`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio))
to commit and consume. The point is that the outer repo stops re-implementing
rules the sim already owns — see ticket 301, where a hand-ported copy of
`canEquipItem` drifted and offered a rogue a two-handed sword.

Nothing here is part of the site build. These files are not imported by any UI
code and are not under `engine/`, so they carry no `PROVENANCE.md` row.

## Why the harness exists

`ui/core/proto_utils/utils.ts` cannot be imported under plain Node as-is: some
modules in its import graph touch browser globals when they are evaluated
(`window.location`, `localStorage`) or import Vite-only specifiers
(`virtual:i18next-loader`). None of that is anything an exporter reads.

`headless.mts` and `hooks.mjs` stand those things up as inert placeholders so
the real functions can run. **No fork source is modified** to make this work —
that is the whole design constraint, since gratuitous edits to inherited
upstream code are exactly what this effort is avoiding. `headless.mts` lists
each shim and the module that forces it.

## `export_equip_eligibility.mts`

Per-spec sets of item ids that the spec can equip, computed by
`canEquipItem` over `assets/database/db.json`, keyed by the fork's own
`PlayerSpecs` names.

Run from the fork root:

```sh
node --import <tsx-loader> --import ./ui/core/components/individual_sim_ui/upgrades/tools/register.mjs \
  ./ui/core/components/individual_sim_ui/upgrades/tools/export_equip_eligibility.mts <output.json>
```

`<tsx-loader>` is a `file://` URL for `tsx/dist/loader.mjs`; the fork has no
`tsx` of its own, so the outer repo's copy is used. The outer repo's
`scripts/check_equip_eligibility.py` runs exactly this and diffs the result
against the committed `data/equip-eligibility.json` on every `pnpm verify`, so
the command above is not something to run by hand in normal work.

Output is deterministic: spec names sorted, ids sorted ascending, LF endings.
