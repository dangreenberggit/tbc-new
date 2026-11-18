# Upgrades exporters

Node scripts that run the sim's own decision functions and write their
answers as JSON, so an external consumer (a downstream data pipeline) can use
the sim's rules instead of re-implementing them. A hand-written copy of
`canEquipItem` drifts: one offered a rogue a two-handed sword that the gear
picker refuses.

Nothing here is part of the site build. No UI code imports these files.

## Why the harness exists

`ui/sim/proto/items.ts` cannot be imported under plain Node as-is: some
modules in its import graph touch browser globals when they are evaluated
(such as `localStorage`) or import Vite-only specifiers
(`virtual:i18next-loader`). None of that is anything an exporter reads.

`headless.mts` and `hooks.mjs` stand those things up as inert placeholders so
the real functions can run without any change to the sim's source.
`headless.mts` lists each shim and the module that needs it.

## `export_equip_eligibility.mts`

Per-spec sets of item ids that the spec can equip, computed by
`canEquipItem` over `assets/database/db.json`, keyed by the `PlayerSpecs`
names.

Run from the repo root:

```sh
node --import <tsx-loader> --import ./ui/features/upgrades/tools/register.mjs \
  ./ui/features/upgrades/tools/export_equip_eligibility.mts <output.json>
```

`<tsx-loader>` is a `file://` URL for `tsx/dist/loader.mjs`; this repo does
not depend on `tsx`, so use any installed copy. The working directory must be
the repo root: the exporter and the sim's modules import through the
`@sim`/`@generated` aliases, and tsx resolves them from the `paths` in the
`tsconfig.json` of the directory it runs in. From anywhere else the import
fails with `ERR_MODULE_NOT_FOUND` on `@sim/player`.

Output is deterministic: spec names sorted, ids sorted ascending, LF endings.
Each spec's id array is written on a single line: the file holds ~79k ids, and
a line per id would cost a megabyte and swamp the diff of any commit near it.
