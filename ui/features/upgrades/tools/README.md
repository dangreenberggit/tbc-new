# Upgrades exporters

Node scripts that run the fork's **own** decision functions and write their
answers as JSON for the outer repo
([`dgreenberggit/tbc-gear-prio`](https://github.com/dgreenberggit/tbc-gear-prio))
to commit and consume. The point is that the outer repo stops re-implementing
rules the sim already owns — see ticket 301, where a hand-ported copy of
`canEquipItem` drifted and offered a rogue a two-handed sword.

Nothing here is part of the site build. These files are not imported by any UI
code and are not under `engine/`, so they carry no `PROVENANCE.md` row.

`equiv-campaign.mts` and `bulk-spike.mts` were not carried over when this folder
moved from `ui/core/components/individual_sim_ui/upgrades/tools/` (fork branch
`feat/upgrades-tab`, `cb561067`) to `ui/features/upgrades/tools/` (ticket 558);
read them at `cb561067`.

## Why the harness exists

`ui/sim/proto/items.ts` cannot be imported under plain Node as-is: some
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
node --import <tsx-loader> --import ./ui/features/upgrades/tools/register.mjs \
  ./ui/features/upgrades/tools/export_equip_eligibility.mts <output.json>
```

`<tsx-loader>` is a `file://` URL for `tsx/dist/loader.mjs`; the fork has no
`tsx` of its own, so the outer repo's copy is used. The working directory must
be the fork root: the exporter and upstream's own modules import through the
`@sim`/`@generated` aliases, and tsx resolves them from the `paths` in the
`tsconfig.json` of the directory it runs in. From the outer repo's root the
import fails with `ERR_MODULE_NOT_FOUND` on `@sim/player`. The outer repo's
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
the transport signals; the harness only measures.

The three signals in the JSON:

- **S1 `runner`** — the runner class the tab chose, from the `data-runner`
  attribute the tab writes on `[data-testid="upgrades-tab-root"]` after a live
  run. The React tab always runs `WorkerPoolSimRunner`.
- **S2 `requests`** — counts of completed 200 sim responses per endpoint,
  summed over the page session **and every auto-attached worker session**. Every
  `/bulkSimAsync` and `/raidSimAsync` fetch is issued inside a dedicated Web
  Worker, which is its own CDP target, so the harness arms
  `Target.setAutoAttach` and enables `Network` on each worker session — a
  page-session `Network.enable` alone sees none of the sim traffic.
- **S3 `servedWorker`** — a plain `fetch` of `sim_worker.js`, recording
  `wasmRefs` and `readyFalse` (the embedded server rewrites it to
  `net_worker.js`).

S4, a count of page-console messages starting `[upgrades] screening fell back`,
is removed: nothing prints that message since the bulk screening pass was
deleted (ticket 567).

Run it from anywhere (Node 22+, no npm deps):

```sh
node run-tab-cdp.mjs --origin http://localhost:3333 --candidates 40 --out out.json
```

The harness finds every element by its `data-testid` (the React tab, ticket
560): the tab button, the phase selector (`phase-selector`, inside the settings
column, opened through `upgrades-run-settings-summary` below `xl`), the
candidates and iterations pickers (`upgrades-candidates-picker`, always in the
DOM inside a wrapper hidden unless `?upgrades-dev`; `upgrades-iterations-picker`),
the eligible count (`upgrades-eligible-count`, its `data-count`), the run button,
the status line (`upgrades-status`) and the rows of the Upgrades list pane
(`#upgrades-pane-shopping-list`, below-cutoff group opened first). Each picker
value is read back after it is set and the run stops with "did not stick" when
it differs.

Flags: `--origin <url>` (required), `--page` (default
`/tbc/paladin/retribution/`), `--phase` (default 3, the page's default phase),
`--candidates N` (0 = uncapped), `--iterations N` (0 = leave the picker at its
default 3000), `--timeout-ms` (default 2 700 000), `--out <json>` (stdout if
omitted), `--trace-tail`, which samples the progress dialog's message and counter and the
landed row count every 500 ms from the Run click to the end of the run; with it,
`--out` names a directory that gets `result.json` and `tail.jsonl`,
`--force-fallback`, which installs a one-shot `window.Worker` throw so the tab's
transport probe fails and it falls back to the WASM runner over HTTP — the
gate's screen-check twin and its forced-fallback negative. `--iterations` exists
for ticket 411's wall-clock measurement; the shipped default is 3000 iterations.

Two timing fields are recorded on every run: **`firstRowS`** — Run click to the
first `[data-testid="upgrades-result-row"]` (via a
`MutationObserver` installed before the click; `null` if no row lands) — and
**`clickToDoneS`** — click to the `Took` status. **`iterationsRequested`** echoes
the `--iterations` flag.

Ticket 522's cold-worker check adds opt-in flags. Without them the run is
unchanged:

- `--preset-tab <name> --preset <chip>` loads a Gear Sets preset before the
  Upgrades tab opens (the picker is in the Gear tab, hidden once another tab is
  active). `--preset "?"` lists that phase tab's chips, or every tab's with
  `--preset-tab "?"`, and exits 1 before any sim.
- `--wasm-concurrency N` sets `__tbc_new_wasmconcurrency` before navigation; at
  1 the page does not split its sim, so its DPS is comparable bit for bit.
- `--capture-requests <dir>` wraps `WorkerPool.prototype.raidSimAsync` before
  the Run click and records each request and its exact `raidMetrics.dps.avg`.
  The first tab call is the baseline. It writes `<dir>/tab-baseline.json`.
- `--page-sim` (needs `--capture-requests`) then runs the page's Simulate at
  seed 11 and the tab's iterations, writes `<dir>/page.json`, and replays that
  request once on the tab's pool with `debugFirstIteration: false` and the
  tab's player name (`<dir>/replay.json`). It sets `#simui-fixed-rng-seed`,
  which upstream renders in the settings dialog; whether that input is in the
  DOM while the dialog is closed is untested on the React page.

New readback fields: `presetTab`, `preset`, `wasmConcurrency`, `captureError`,
`tabSimCalls`, `pageSimCalls`, `calls`, `tabBaseline`,
`tabBaselineMatchesDisplay`, `tabBaselineRequest`, `pageRequest`, `pageDps`,
`pagePlayerDps`, `pageSeed`, `pageIterations`, `pageError`, `dpsDiff`,
`dpsEqual`, `replayDps`, `replayEqual`, `replay`, `exact`, `requestCheck`
(consumable and spell-effect ids per side, `effectIdsCovered`,
`tabCallsWithPageRows`, `otherDiffPaths`, `otherDiffCount`), and
`pageSimError` / `replayError` when a step fails.
