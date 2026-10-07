/**
 * WorkerPoolSimRunner — SimRunner over the site's own WorkerPool (WASM workers
 * on the web build, HTTP net workers on the desktop build) (plan §2.4).
 *
 * Owns an independent `WorkerPool`, rather than reaching into `Sim`'s
 * private `workerPool` field — `Sim.workerPool` has no public accessor
 * (`ui/core/sim.ts`), and `WorkerPool`'s own constructor is self-contained
 * (points every worker at the fixed `SIM_WORKER_URL`, no dependency on `Sim`
 * state), so a second pool is the same kind of object the page already runs,
 * not a workaround.
 *
 * Deliberately does **not** call `runConcurrentSim`
 * (`ui/core/sim_concurrent.ts`): that function splits *one request's
 * iterations* across workers by sharding the seed
 * (`sim/core/sim_concurrent.go`'s `SplitSimRequestForConcurrency`), which is
 * a different number for a different worker count (confirmed empirically in
 * `docs/plans/compute-topology.md` §3.1 — same seed, different core count,
 * different float in the last few digits). So `raidSimAsync` is called once per
 * candidate, unsharded, and the pool's own least-busy-worker balancing
 * (`WorkerPoolManager`) is what runs several candidates concurrently.
 *
 * The old tab's bulk screening runners were measured slower than this loop and
 * deleted, with the engine's bulk branch (tbc-gear-prio tickets 411 and 567).
 */

import { ComputeStatsRequest, RaidSimRequest as RaidSimRequestProto } from '@generated/proto/api';
import type { JsonValue } from '@protobuf-ts/runtime';
import { CURRENT_API_VERSION } from '@sim/constants/other';
import { RequestTypes, SimSignalManager } from '@sim/sim_signal_manager';
import { generateRequestId, WorkerPool } from '@sim/workers/worker_pool';
import { SimRequest } from '@worker/types';

import type { PlayerStatsObservation, RaidSimRequest, SimObservation, SimRunner, SimRunOpts } from '../engine/seams/sim-runner';

/** Matches upstream's own default (`ui/core/sim.ts`'s WorkerPool(1) plus its
 * wasm-concurrency auto-sizing, capped at 4 — see that file's constructor). */
export const DEFAULT_WORKER_COUNT = 4;

/**
 * How long a tab worker may send nothing while a request waits on it before
 * the request fails and the worker restarts (tickets 545, 553, 556, 557). Measured in the
 * browser build (tbc-gear-prio `.scratch/stage-gate/545-worker-silence-check/measurement.md`,
 * `.scratch/stage-gate/553-554-silence-followups/probe.md` and
 * `.scratch/stage-gate/555-557-silence-followups/557-page-sims.md`) and in the desktop build
 * (`.scratch/stage-gate/555-557-silence-followups/557-desktop.md`):
 * - start-up: ten times 1.777 s plus 120 s = 137.8 s, rounded up to the next 10 s
 *   (measurement.md:13); 1.777 s is the longest silence from creation to `ready`, and the
 *   120 s is for the wasm download, which localhost cannot measure;
 * - presim: ten times the longest warm-up pass at the default boss health (enhancement
 *   shaman, 21.43 s, 557-page-sims.md), rounded up to the next 10 s: 214.3 → 220 s; 120 s
 *   until ticket 557, from feral's 11.7 s. A warm-up pass runs from a sim's post to its
 *   first `PresimRunning: false`;
 * - run: ten times the longest main-loop silence measured, floor 30 s, cap 90 s
 *   (measurement.md:14): feral cat on the desktop build, 4.483 s (557-desktop.md), gives
 *   44.83 s; the 30 s floor until ticket 557. All four tab workers were silent in the same
 *   window of that run; the cause is unknown (557-desktop.md).
 * The factor of ten is a margin, not derived from a measurement. The 545 plan's claim C17
 * reads "Margin: 10× covers a 1,000-DPS spec (2.5×) and a machine 4× slower" (hypothesis,
 * untested). Its 2.5× rests on "the presim scales with fight length" (545 plan.md:33), and
 * the measured warm-ups contradict that: enhancement shaman's 3,039 s fight warmed up in
 * 21.4 s and shadow priest's 3,822 s fight in 4.5 s (557-page-sims.md, probe.md). 220 s is
 * 10.3× the longest measured warm-up (220 / 21.43). A spec not listed below may warm up for
 * longer, and a slower machine stretches every number (both hypotheses, untested).
 *
 * The warm-up is a fixed 100-iteration run (`sim/core/presim.go:35`), run only when the fight
 * ends at a health value (`presim.go:66`), and one round for DPS specs because the only
 * presimmer is the tank healing model (`sim/core/health.go:272`). So the 220 s limit fails a
 * spec whose single iteration at default boss health takes more than 2.2 s (slowest
 * measured: 214 ms, enhancement shaman).
 *
 * Silence is per worker: a second sim posted to a worker is judged from that worker's last
 * message, and the worker's answer to the second request's id counts as a message
 * (ticket 556).
 *
 * At these limits a freeze that ends about 40-50 s into a main-loop silence, or about
 * 199-225 s into a warm-up silence, fails a healthy worker (see the `worker_silence.ts`
 * header).
 *
 * Longest silences measured, per spec (warm-up at the default boss health;
 * main loop):
 * - feral cat: warm-up 11.7 s, main loop 1.0 s (ticket 545; 1.020 s per ticket 553 — the
 *   1.144 s in measurement.md:53 was a warm-up silence under the regime rule)
 * - warlock: warm-up 1.8 s, main loop 0.2 s (ticket 553)
 * - shadow priest: warm-up 4.5 s, main loop 0.5 s (ticket 553)
 * - hunter (beast mastery, pet): warm-up 15.1 s, main loop 1.2 s (ticket 557)
 * - enhancement shaman (totems): warm-up 21.4 s, main loop 1.3 s (ticket 557)
 * - rogue (combat, dual wield): warm-up 15.7 s, main loop 1.5 s (ticket 557)
 * - feral cat, desktop build (HTTP worker, `:3333`): start-up 0.7 s, warm-up regime 4.3 s,
 *   main loop 4.5 s (ticket 557, 557-desktop.md); the desktop worker leaves the warm-up
 *   regime at its first poll, so its warm-up is judged against the run limit
 * The hunter, enhancement shaman and rogue lines are from 557-page-sims.md: dev machine, four
 * page workers at once. The desktop line is from 557-desktop.md: dev machine, one Upgrades-tab
 * run with four tab workers, on a fight that ends at 441,198 health.
 */
export const WORKER_SILENCE_LIMITS = { startMs: 140_000, runMs: 44_830, presimMs: 220_000 } as const;

/**
 * E-W5 measured **183.8 MB** peak RSS for one `wowsimcli` process running
 * 5,000 iterations (candidate-pool.md §3.1) — the Node/CLI sim binary, not
 * this browser's WASM worker. No in-browser RSS-per-worker measurement
 * exists yet (that number was explicitly out of scope for E-W5, which ran
 * against the CLI), so this constant is the CLI figure carried over as the
 * best available proxy: same Go sim core compiled to WASM instead of a
 * native binary, running the same fixed-duration encounter loop that
 * dominates RSS. Treat `memoryCapFromDeviceMemory` below as a
 * **hypothesis**, not a measured browser number, until a WASM-side RSS
 * sample replaces it — flagged here so a future change to this constant
 * updates the reasoning in both places at once.
 */
const MEASURED_MB_PER_SIM_PROCESS = 183.8;

/**
 * `min(workers, memoryCap)` per candidate-pool.md §5.1.2/§5.2. `memoryCap`
 * comes from `navigator.deviceMemory` (Chrome/Chromium only — the Device
 * Memory API; Firefox and Safari never expose it and the property is
 * `undefined` there), read as an approximate device RAM figure in GiB.
 * Reserves half of reported RAM for everything else already running (the
 * OS, the tab's own DOM/JS heap, other tabs) rather than assuming this sim
 * can claim the whole figure, then divides the remainder by the measured
 * per-process cost above. Falls back to `DEFAULT_WORKER_COUNT` (matching
 * upstream's own hardcoded default, `ui/core/sim.ts`) when the API is
 * unavailable, so a Firefox/Safari user is not capped to 1 by a browser
 * quirk unrelated to their actual RAM. The caller reads `navigator.deviceMemory`
 * (`utils/runner_env.ts`): `model/` may not touch browser globals.
 */
export function memoryCapFromDeviceMemory(deviceMemoryGiB: number | undefined): number {
	if (deviceMemoryGiB === undefined) return DEFAULT_WORKER_COUNT;
	const usableMb = (deviceMemoryGiB * 1024) / 2;
	const cap = Math.floor(usableMb / MEASURED_MB_PER_SIM_PROCESS);
	return Math.max(1, cap);
}

/**
 * The browser values the tab sizes its worker pool from. `model/` may not touch
 * browser globals (`.oxlintrc.json`), so `utils/runner_env.ts` reads them and
 * the caller passes them in.
 */
export type RunnerEnv = {
	/** `localStorage.getItem`; may throw when storage is unavailable. */
	storageRead: (key: string) => string | null;
	/** `navigator.hardwareConcurrency`; 0 or undefined when unknown. */
	hardwareConcurrency: number | undefined;
	/** `navigator.deviceMemory` in GiB; undefined outside Chromium. */
	deviceMemoryGiB: number | undefined;
};

/** The user's own worker-count choice in the site's settings; `0` is a deliberate "off". */
const WASM_CONCURRENCY_KEY = '__tbc_new_wasmconcurrency';

/**
 * The user's worker-count setting: the default when the key is absent, the
 * stored number when it is readable, and undefined when the store throws or
 * the value is not a finite number.
 */
function readWasmConcurrency(storageRead: RunnerEnv['storageRead']): number | undefined {
	try {
		const raw = storageRead(WASM_CONCURRENCY_KEY);
		if (raw === null) return DEFAULT_WORKER_COUNT;
		const parsed = Number(JSON.parse(raw));
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How many workers the tab's pool gets. A choice above one is capped by the
 * cores and by `memoryCapFromDeviceMemory`, with a floor of two; no choice
 * counts as the default and is capped the same way. Off (`0`) and `1` get one
 * worker, because the tab cannot rank with none. An unreadable setting gets
 * the default, uncapped.
 */
export function workerCountFor(env: RunnerEnv): number {
	const setting = readWasmConcurrency(env.storageRead);
	if (setting === undefined) return DEFAULT_WORKER_COUNT;
	if (setting <= 1) return 1;
	const cores = env.hardwareConcurrency || DEFAULT_WORKER_COUNT;
	return Math.max(2, Math.min(setting, cores, memoryCapFromDeviceMemory(env.deviceMemoryGiB)));
}

export class WorkerPoolSimRunner implements SimRunner {
	private readonly pool: WorkerPool;
	private readonly signalManager = new SimSignalManager();

	/**
	 * `min(workers, memoryCap)` (candidate-pool.md §5.1.2) — how many
	 * candidate sims `rankUpgrades`'s `promisePool` may dispatch at once.
	 * Distinct from the `WorkerPool`'s own `numWorkers`: that number sizes
	 * how many WASM workers exist to *service* requests; this number caps how
	 * many *requests* are in flight so their combined memory stays under
	 * `memoryCap`. `numWorkers` is itself already `min`-folded in when it is
	 * lower than the memory cap, since dispatching more requests than there
	 * are workers to run them buys nothing.
	 */
	readonly concurrency: number;

	constructor(numWorkers: number = DEFAULT_WORKER_COUNT, deviceMemoryGiB?: number) {
		this.pool = new WorkerPool(numWorkers, { silence: WORKER_SILENCE_LIMITS });
		this.concurrency = Math.max(1, Math.min(numWorkers, memoryCapFromDeviceMemory(deviceMemoryGiB)));
	}

	async version(): Promise<string> {
		return `api-v${CURRENT_API_VERSION}`;
	}

	/** Ends this runner's WASM workers; the tab calls it when it unmounts. */
	terminate(): void {
		this.pool.terminate();
	}

	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
		// Only the set screen asks for per-iteration values (ticket 511). Without
		// the option, the request and the observation are exactly as before.
		const saveAllValues = opts.saveAllValues === true;
		const withOptions = {
			...req,
			requestId: generateRequestId(SimRequest.raidSimAsync),
			simOptions: {
				iterations: opts.iterations,
				// protobuf-ts int64 fields accept a numeric string on fromJson;
				// matches how the CLI seam (packages/core/src/seams/cli-sim-runner.ts)
				// and the recorded fixtures already spell a seed (D4's sibling
				// adaptation, same convention, not a new one invented here).
				randomSeed: String(opts.seed),
				debugFirstIteration: false,
				...(saveAllValues ? { saveAllValues: true } : {}),
			},
		};

		const proto = RaidSimRequestProto.fromJson(withOptions, {
			ignoreUnknownFields: true,
		});

		const signals = this.signalManager.registerRunning(RequestTypes.IndividualSim);
		try {
			const result = await this.pool.raidSimAsync(proto, () => {}, signals);
			if (result.error) {
				throw new Error(`sim error (${result.error.type}): ${result.error.message}`);
			}
			const dps = result.raidMetrics?.dps;
			if (!dps) {
				throw new Error('sim result has no raidMetrics.dps');
			}
			return {
				dps: dps.avg,
				stdev: dps.stdev,
				iterationsDone: result.iterationsDone,
				simVersion: await this.version(),
				...(saveAllValues ? { allValues: [...dps.allValues] } : {}),
			};
		} finally {
			this.signalManager.unregisterRunning(signals);
		}
	}

	/**
	 * The first player's final stats for the request's gear (ticket 535), the
	 * call the page's own stats panel makes (`ui/core/sim.ts`
	 * `getCharacterStatsForGear`). Meta repair reads hit from it.
	 */
	async computeStats(req: RaidSimRequest): Promise<PlayerStatsObservation> {
		const proto = ComputeStatsRequest.fromJson({ raid: req.raid, encounter: req.encounter } as JsonValue, { ignoreUnknownFields: true });
		const result = await this.pool.computeStats(proto);
		if (result.errorResult !== '') {
			throw new Error(`computeStats error: ${result.errorResult}`);
		}
		const finalStats = result.raidStats?.parties[0]?.players[0]?.finalStats;
		if (!finalStats) {
			throw new Error('computeStats result has no first player finalStats');
		}
		return { stats: [...finalStats.stats], pseudoStats: [...finalStats.pseudoStats] };
	}
}
