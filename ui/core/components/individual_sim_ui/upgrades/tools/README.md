# Upgrades exporters

Node scripts that run the fork's **own** decision functions and write their
answers as JSON for the outer repo
([`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio))
to commit and consume. The point is that the outer repo stops re-implementing
rules the sim already owns — see ticket 301, where a hand-ported copy of
`canEquipItem` drifted and offered a rogue a two-handed sword.

Nothing here is part of the site build. These files are not imported by any UI
code and are not under `engine/`, so they carry no `PROVENANCE.md` row.

`equiv-campaign.mts` is the one exception to "Node scripts": it runs in the
browser, not under Node. It is kept here anyway because it is the same kind of
thing — a measurement tool that is not part of the shipped tab. See its own
header for what it does and why it instruments rather than re-implements. Its
`runDiagnostic` export answers a narrower question — whether the bulk screening
numbers are actually used, and whether the engine is deterministic at a fixed
seed — which is what established that the two routes agree by determinism rather
than by a caching bug.

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
Each spec's id array is written on a single line — the file holds ~79k ids, and
a line per id would cost a megabyte and swamp the diff of any commit near it
while telling a reader nothing the checker's own error output does not already
name.

## `run-tab-cdp.mjs`

The durable CDP harness for the desktop-transport gate, promoted from Chunk 1's
throwaway `ret-p5-run.mjs`. It drives a full or capped ret upgrades run against
**any origin the caller already serves** — the WASM page under `http-server`, or
the packaged desktop binary on `:3333` — and writes a readback JSON recording
what the tab actually did, not what the origin implies. The outer repo's
`scripts/check_desktop_tab.py` (`pnpm desktop-gate:check`) drives it and judges
the four transport signals; the harness only measures.

The four signals in the JSON:

- **S1 `runner`** — the runner class the tab chose, from the `data-runner`
  attribute the tab writes on `.upgrades-status` (`BulkHttpSimRunner` on the HTTP
  transport, `WasmSimRunner` on WASM or a forced fallback).
- **S2 `requests`** — counts of completed 200 sim responses per endpoint,
  summed over the page session **and every auto-attached worker session**. Every
  `/bulkSimAsync` and `/raidSimAsync` fetch is issued inside a dedicated Web
  Worker, which is its own CDP target, so the harness arms
  `Target.setAutoAttach` and enables `Network` on each worker session — a
  page-session `Network.enable` alone sees none of the sim traffic.
- **S3 `servedWorker`** — a plain `fetch` of `sim_worker.js`, recording
  `wasmRefs` and `readyFalse` (the embedded server rewrites it to
  `net_worker.js`).
- **S4 `screeningFallbackWarnings`** — count of page-console messages starting
  `[upgrades] screening fell back`; must be 0 on a clean screened run.

Run it from anywhere (Node 22+, no npm deps):

```sh
node run-tab-cdp.mjs --origin http://localhost:3333 --candidates 40 --out out.json
```

Flags: `--origin <url>` (required), `--page` (default
`/tbc/paladin/retribution/`), `--phase` (default 5), `--candidates N` (0 =
uncapped), `--timeout-ms` (default 2 700 000), `--out <json>` (stdout if
omitted), and `--force-fallback`, which installs a one-shot `window.Worker`
throw so the tab's transport probe fails and it falls back to the WASM runner
over HTTP — the gate's screen-check twin and its forced-fallback negative.
