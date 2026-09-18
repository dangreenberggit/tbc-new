/**
 * Track B measurement harness (tickets 345, 346, 348).
 *
 * Runs one campaign arm and records what it cost. It **judges nothing** — the
 * scorer under `.scratch/stage-gate/batch-sim-followups/evidence/` applies the
 * pre-registered rules to the dump this produces. Keeping the two apart is the
 * point: a harness that scored itself could not be trusted to have measured
 * honestly.
 *
 * ## Why this instruments rather than re-implements
 *
 * An earlier design re-implemented `BulkWasmSimRunner.runBulkScreen`'s body so
 * the per-chunk `stageMetrics` could be captured. That is no longer the right
 * approach: the chunk loop now lives in the shared `runBulkScreenChunks`, which
 * both runners delegate to, and re-implementing it would mean measuring a copy
 * of the code path instead of the one that ships — and would bypass
 * `assertSingleStageChunk` and the cancel wiring that live inside the driver.
 *
 * So the harness calls the **real** driver and wraps only the `dispatch`
 * callback the driver already takes as a dependency. Everything the campaign
 * needs (each chunk's raw `stageMetrics`, its wall time, its baseline-probe
 * progress events) is observable from that one seam, and the shipped loop runs
 * untouched around it.
 *
 * The consequence for the Step 2 differential is deliberate: `mode=real` and
 * `mode=harness` now differ *only* by whether the dispatch is wrapped, so the
 * differential proves the instrumentation is **observation-only**. It is no
 * longer evidence about a re-implementation's fidelity, because there is no
 * re-implementation left to be unfaithful.
 *
 * ## How to drive it
 *
 * This module is committed; the tab dispatch that calls it is NOT. Running an
 * arm means re-adding a temporary block to `upgrades_tab.tsx`'s `run()`, just
 * after `const sim = await this.simRunner();`, gated on a `?bulkEquiv=A|B|C`
 * query parameter, which calls `runCampaignArm` and parks the result on
 * `window.__bulkEquiv`. Deliberately not shipped: a measurement hook wired into
 * the tab permanently is a footgun, and the campaign needs it for hours rather
 * than forever. `.scratch/stage-gate/batch-sim-followups/execution-ledger-b.md`
 * records the exact block used, and the scorer beside it consumes the dump.
 *
 * Arm A is the bulk route (`hasBulkCapability` true), B and C the per-candidate
 * loop; C differs from B only in its first seed, which is what makes it the
 * loop-vs-loop null.
 *
 * ## A note on what "single-stage" means here
 *
 * `shouldUseLegacyBulkSim` is evaluated per chunk inside `runConcurrentBulkSim`
 * (`wasm/bulk_sim/index.ts:107`), and the driver partitions at
 * `MAX_CANDIDATES_PER_BULK_REQUEST = 25` before dispatching. At n <= 25 no
 * pre-High stage runs at any iteration count, so every chunk this harness ever
 * measures takes the single-stage High path. Nothing here measures a
 * multi-stage tournament, and the 346 write-up must not claim otherwise.
 */

import { BulkSimRequest, BulkSimResult } from '../../../../proto/api.js';
import { ProgressMetrics } from '../../../../proto/api.js';
import { SimSignalManager, SimSignals } from '../../../../sim_signal_manager.js';
import { WorkerPool } from '../../../../worker_pool.js';
import { runConcurrentBulkSim } from '../../../../wasm/bulk_sim/index.js';
import { BulkHttpSimRunner } from '../adapters/bulk_http_sim_runner.js';
import { runBulkScreenChunks } from '../adapters/bulk_screen_driver.js';
import { BulkWasmSimRunner, makeSimRunner } from '../adapters/bulk_wasm_sim_runner.js';
import type { WorkerPoolSimRunner } from '../adapters/worker_pool_sim_runner.js';
import { cutoffForSpec } from '../engine/cutoff.js';
import { rankUpgrades, type RankInput, type Ranking, type PartialRanking } from '../engine/rank.js';
import type { BulkScreenRequest, BulkScreenResult, RaidSimRequest, SimObservation, SimRunOpts, SimRunner } from '../engine/seams/sim-runner.js';
import { MemoryStore } from '../engine/seams/store.js';

export type ArmId = 'A' | 'B' | 'C';
export type ArmMode = 'real' | 'harness';

/** One `run()` call at the SimRunner seam. */
export type RunRecord = {
	phase: string;
	/**
	 * `true` once the engine has emitted `stage: "ranking"` — i.e. this sim
	 * belongs to the set-bonus / paired-replication tail rather than to the
	 * screening pass. That tail is identical work on both routes, so the 346
	 * verdict is taken on the screening-only figures that exclude it.
	 */
	tail: boolean;
	iterationsDone: number;
	seconds: number;
	seed: number;
	iterations: number;
};

/** One dispatched bulk chunk, as the engine actually answered it. */
export type ChunkRecord = {
	n: number;
	seconds: number;
	stages: number;
	/** Achieved iterations of the LAST stage — what M2 pins to 8,000. */
	stageIterations: number;
	/** Every stage's achieved iterations, so an overshoot is attributable. */
	stageIterationsAll: number[];
	/** Baseline probes observed on this chunk's progress stream. */
	probes: number;
	rows: number;
};

export type CampaignDump = {
	armId: ArmId;
	mode: ArmMode;
	iterations: number;
	seeds: number[];
	transport: { isWasm: boolean; hasBulkCapability: boolean; concurrency: number };
	config: Record<string, unknown>;
	engineCutoff: { absDps: number; pct: number };
	baseline?: { dps: number; stdev: number };
	cost: {
		wallSeconds: number;
		screeningSeconds: number;
		firstRowSeconds: number | undefined;
		simsByPhase: Record<string, number>;
		totalIterations: number;
		screeningIterations: number;
		chunks: ChunkRecord[];
		runs: RunRecord[];
	};
	items: Array<Record<string, unknown>>;
	failures?: unknown;
	complete: boolean;
};

/**
 * Wraps a runner so every `run()` is counted and timed, and — when the runner
 * has a bulk capability — so every dispatched chunk is recorded.
 *
 * `phase` is the caller-supplied tag for whatever `rankUpgrades` is doing at the
 * time. It is set by the campaign around the call, not inferred here, because
 * only the caller knows which pass it is in.
 */
class CountingRunner implements SimRunner {
	readonly runs: RunRecord[] = [];
	readonly chunks: ChunkRecord[] = [];
	phase = 'unknown';
	/** Flipped by the campaign when `stage: "ranking"` is observed. */
	tail = false;
	screeningSeconds = 0;
	baseline: { dps: number; stdev: number } | undefined;

	constructor(
		private readonly inner: WorkerPoolSimRunner | BulkHttpSimRunner,
		/** Absent on arm B/C: no bulk capability is exposed at all. */
		private readonly bulkDriver?: (req: BulkScreenRequest, record: (chunk: ChunkRecord) => void) => Promise<BulkScreenResult>,
	) {
		if (bulkDriver) {
			// An own property, not a prototype method: `rank.ts` treats
			// `deps.sim.runBulkScreen` as a truthy capability check, so arms B and C
			// must not appear to have it at all.
			this.runBulkScreen = async (req: BulkScreenRequest) => {
				const startedAt = performance.now();
				try {
					const result = await bulkDriver(req, chunk => this.chunks.push(chunk));
					this.baseline = { dps: result.baseline.dps, stdev: result.baseline.stdev };
					return result;
				} finally {
					this.screeningSeconds += (performance.now() - startedAt) / 1000;
				}
			};
		}
	}

	runBulkScreen?: (req: BulkScreenRequest) => Promise<BulkScreenResult>;

	get concurrency(): number {
		return (this.inner as { concurrency: number }).concurrency;
	}

	version(): Promise<string> {
		return this.inner.version();
	}

	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
		const startedAt = performance.now();
		const observation = await this.inner.run(req, opts);
		this.runs.push({
			phase: this.phase,
			tail: this.tail,
			iterationsDone: observation.iterationsDone,
			seconds: (performance.now() - startedAt) / 1000,
			seed: opts.seed,
			iterations: opts.iterations,
		});
		return observation;
	}
}

/** Reads a chunk's achieved stage iterations and probe count off the raw result. */
function chunkRecordFrom(result: BulkSimResult, n: number, seconds: number, probes: number): ChunkRecord {
	const stageIterationsAll = result.stageMetrics.map(metric => metric.iterations);
	return {
		n,
		seconds,
		stages: result.stageMetrics.length,
		stageIterations: stageIterationsAll.at(-1) ?? 0,
		stageIterationsAll,
		probes,
		rows: result.topResults.length,
	};
}

/**
 * Builds the instrumented dispatch for a transport. The driver is the real one;
 * only what it is handed is wrapped, and the wrapper does nothing but time the
 * call, count baseline-probe progress events and copy the raw `stageMetrics`
 * out of the response before returning it untouched.
 */
function instrumentedDriver(
	transportDispatch: (request: BulkSimRequest, signals: SimSignals, onProgress: (metrics: ProgressMetrics) => void) => Promise<BulkSimResult>,
	signals: SimSignalManager,
	simVersion: () => Promise<string>,
) {
	return async (req: BulkScreenRequest, record: (chunk: ChunkRecord) => void): Promise<BulkScreenResult> =>
		runBulkScreenChunks(req, {
			signals,
			simVersion: await simVersion(),
			dispatch: async (request, chunkSignals) => {
				const startedAt = performance.now();
				let probes = 0;
				let presimWas = false;
				const result = await transportDispatch(request, chunkSignals, metrics => {
					// `presimRunning` is a level, not an event, so probes are its
					// RISING edges. Counting every truthy tick would report the
					// progress stream's sampling rate rather than the probe count.
					if (metrics.presimRunning && !presimWas) probes++;
					presimWas = metrics.presimRunning;
				});
				record(chunkRecordFrom(result, request.candidates.length, (performance.now() - startedAt) / 1000, probes || 1));
				return result;
			},
		});
}

/** The bulk-capable runner for this transport, with its dispatch instrumented. */
function bulkRunnerFor(inner: WorkerPoolSimRunner | BulkHttpSimRunner, isWasm: boolean, mode: ArmMode) {
	const signals = new SimSignalManager();
	const simVersion = () => inner.version();

	if (mode === 'real') {
		// The shipped runner, wrapped by nothing but the seam decorator. Chunk
		// records are unavailable in this mode by construction — that is what
		// makes it the control the differential compares against.
		return async (req: BulkScreenRequest) => (inner as BulkWasmSimRunner | BulkHttpSimRunner).runBulkScreen(req);
	}

	if (isWasm) {
		const pool = new WorkerPool((inner as { concurrency: number }).concurrency);
		return instrumentedDriver((request, chunkSignals, onProgress) => runConcurrentBulkSim(request, pool, onProgress, chunkSignals), signals, simVersion);
	}
	const pool = new WorkerPool(1);
	return instrumentedDriver((request, chunkSignals, onProgress) => pool.bulkSimAsync(request, onProgress, chunkSignals), signals, simVersion);
}

export type CampaignArmOptions = {
	armId: ArmId;
	mode: ArmMode;
	input: RankInput;
	deps: {
		gear: unknown;
		raidSimSkeleton: unknown;
		epWeights: unknown;
		pool: unknown;
		simDatabaseFor: unknown;
		clock: () => Date;
		signal?: AbortSignal;
	};
	seeds: number[];
	isWasm: boolean;
	config: Record<string, unknown>;
	onProgress?: (progress: unknown) => void;
};

/**
 * Runs one arm end to end and returns its dump.
 *
 * A fresh `MemoryStore` per arm, constructed here rather than passed in: the
 * store dedupes identical requests, so a store shared across arms would let arm
 * B answer from arm A's cache and silently report a cost of nearly zero.
 */
export async function runCampaignArm(opts: CampaignArmOptions): Promise<CampaignDump> {
	const store = new MemoryStore();
	const isBulkArm = opts.armId === 'A';

	const base = makeSimRunner(false);
	const inner: WorkerPoolSimRunner | BulkHttpSimRunner = opts.isWasm
		? isBulkArm
			? new BulkWasmSimRunner(base.concurrency)
			: base
		: isBulkArm
			? new BulkHttpSimRunner(base.concurrency)
			: base;

	const bulkDriver = isBulkArm
		? (() => {
				const driver = bulkRunnerFor(inner, opts.isWasm, opts.mode);
				return opts.mode === 'real'
					? async (req: BulkScreenRequest) => (driver as (r: BulkScreenRequest) => Promise<BulkScreenResult>)(req)
					: (driver as (req: BulkScreenRequest, record: (chunk: ChunkRecord) => void) => Promise<BulkScreenResult>);
			})()
		: undefined;

	const counting = new CountingRunner(
		inner,
		bulkDriver
			? opts.mode === 'real'
				? async (req, _record) => (bulkDriver as (r: BulkScreenRequest) => Promise<BulkScreenResult>)(req)
				: (bulkDriver as (req: BulkScreenRequest, record: (chunk: ChunkRecord) => void) => Promise<BulkScreenResult>)
			: undefined,
	);

	const startedAt = performance.now();
	let firstRowSeconds: number | undefined;

	counting.phase = 'baseline';
	let ranking: Ranking | PartialRanking;
	try {
		ranking = await rankUpgrades(
			// `seeds` MUST go into the input, not just into the dump. `rank.ts:564`
			// reads `input.seeds ?? DEFAULT_SEEDS` and takes `seeds[0]` as the
			// screening seed, so an arm that only *records* its seeds runs at the
			// default 11 regardless of what it claims — which is exactly the bug
			// that made arm C a byte-identical repeat of arm B instead of a null.
			{ ...opts.input, seeds: opts.seeds },
			{
				...(opts.deps as Record<string, unknown>),
				sim: counting,
				store,
				concurrency: counting.concurrency,
			} as never,
			progress => {
				if (progress && typeof progress === 'object' && 'kind' in progress && (progress as { kind: string }).kind === 'row') {
					firstRowSeconds ??= (performance.now() - startedAt) / 1000;
				} else if (progress && typeof progress === 'object' && 'stage' in progress) {
					const stage = String((progress as { stage: unknown }).stage);
					counting.phase = stage;
					// One-way latch: `ranking` fires once, between the screening pass
					// and the set-bonus/replication tail. Latching rather than
					// comparing keeps every later sim tagged as tail even though the
					// engine emits no further stage events after this point.
					if (stage === 'ranking') counting.tail = true;
				}
				opts.onProgress?.(progress);
			},
		);
	} finally {
		// Nothing to clean up beyond letting the timer below read a real end.
	}

	const wallSeconds = (performance.now() - startedAt) / 1000;
	const cutoff = cutoffForSpec(opts.input.spec);

	const simsByPhase: Record<string, number> = {};
	for (const record of counting.runs) simsByPhase[record.phase] = (simsByPhase[record.phase] ?? 0) + 1;

	const runIterations = counting.runs.reduce((sum, record) => sum + record.iterationsDone, 0);
	const chunkIterations = counting.chunks.reduce((sum, chunk) => sum + (chunk.rows + chunk.probes) * chunk.stageIterations, 0);

	// "Screening-only" per the pre-registration: for arm A the `runBulkScreen`
	// span; for B and C the per-candidate sim phase of the loop.
	//
	// The engine's `Progress` vocabulary cannot express that split on its own —
	// `simming` covers the screening sims AND the set-bonus/replication tail,
	// which is precisely the identical work on both routes that would dilute the
	// ratio toward 1.0. But `rank.ts` emits `stage: "ranking"` at line 1314,
	// after `screenCandidates` (1213) and before `replicateTopItems` (1336) and
	// the set-bonus packages (1297). So that event is the boundary, and a `run`
	// recorded before it is screening while one recorded after it is the tail.
	// Tagged from the observed event order rather than guessed from sim counts.
	// `building-pool` is the baseline probe, not screening: it is one sim, it
	// runs on both routes identically, and counting it would inflate the loop's
	// screening cost by exactly the work bulk also pays.
	const isScreeningRun = (record: RunRecord) => record.phase === 'simming';
	const screeningRunIterations = counting.runs.filter(record => record.tail === false && isScreeningRun(record)).reduce((sum, record) => sum + record.iterationsDone, 0);
	const screeningSeconds = isBulkArm
		? counting.screeningSeconds
		: counting.runs.filter(record => record.tail === false && isScreeningRun(record)).reduce((sum, record) => sum + record.seconds, 0);

	// `RankInput.iterations` is optional at the type level; the campaign always
	// pins it (M2), and a dump that could not say what it ran at would be
	// unscoreable — so an absent value is a harness bug, not a default.
	if (opts.input.iterations === undefined) throw new Error('campaign arm requires an explicit iteration count (M2 pins every arm)');

	// The dump's `seeds` must describe the seeds the arm actually ran at. The
	// screening pass dispatches at `seeds[0]` (`rank.ts:572-573`), so if the
	// recorded first seed and the observed one ever disagree, the arm is
	// mislabelled — a control that is secretly a repeat of its own baseline.
	// That happened once and produced a byte-identical "null" arm, so it fails
	// loudly here rather than reaching the scorer.
	const observedScreenSeeds = [...new Set(counting.runs.filter(record => !record.tail).map(record => record.seed))];
	if (observedScreenSeeds.length > 1 || (observedScreenSeeds.length === 1 && observedScreenSeeds[0] !== opts.seeds[0])) {
		throw new Error(`arm ${opts.armId} declares seeds[0]=${opts.seeds[0]} but screened at ${observedScreenSeeds.join(',')} — the seeds never reached rankUpgrades`);
	}

	return {
		armId: opts.armId,
		mode: opts.mode,
		iterations: opts.input.iterations,
		seeds: opts.seeds,
		transport: { isWasm: opts.isWasm, hasBulkCapability: counting.runBulkScreen !== undefined, concurrency: counting.concurrency },
		config: opts.config,
		engineCutoff: { absDps: cutoff.absDps, pct: cutoff.pct },
		baseline: counting.baseline,
		cost: {
			wallSeconds,
			screeningSeconds,
			firstRowSeconds,
			simsByPhase,
			totalIterations: runIterations + chunkIterations,
			screeningIterations: isBulkArm ? chunkIterations : screeningRunIterations,
			chunks: counting.chunks,
			runs: counting.runs,
		},
		items: ranking.items.map(item => ({
			itemId: item.itemId,
			name: item.name,
			rank: item.rank ?? null,
			deltaDps: item.deltaDps,
			deltaPct: item.deltaPct,
			se: item.se,
			seMethod: item.seMethod,
			belowCutoff: item.belowCutoff,
		})),
		complete: ranking.complete,
	};
}

/**
 * Diagnostic for the identical-deltas anomaly (Track B, D-1/D-2).
 *
 * Runs the REAL `rankUpgrades` twice at a small cap — once with the bulk
 * capability exposed, once without — through a runner that records every
 * `run()` request it is handed. That gives both discriminators from the code
 * path the campaign actually measures, rather than from a re-composed request
 * that might differ:
 *
 * - **D-1** (hit/miss): the bulk arm's `run()` count during screening. If the
 *   screened map is used, screening costs ~0 `run()` calls; if every attempt
 *   falls through, it costs one per attempt.
 * - **D-2** (determinism): the recorded requests are replayed — the same
 *   request twice through the loop route, and the bulk arm's screened DPS for
 *   one attempt against that attempt's loop DPS.
 */
export async function runDiagnostic(opts: {
	input: RankInput;
	deps: Record<string, unknown>;
	sim: WorkerPoolSimRunner | BulkHttpSimRunner;
	isWasm: boolean;
}): Promise<{ summary: Record<string, unknown>; detail: Record<string, unknown> }> {
	type Seen = { req: RaidSimRequest; opts: SimRunOpts; obs: SimObservation; tail: boolean };

	const runArm = async (withBulk: boolean) => {
		const seen: Seen[] = [];
		let tail = false;
		const inner = opts.sim;
		const recorder: SimRunner = {
			version: () => inner.version(),
			async run(req, runOpts) {
				const obs = await inner.run(req, runOpts);
				seen.push({ req, opts: runOpts, obs, tail });
				return obs;
			},
		};
		if (withBulk && 'runBulkScreen' in inner) {
			(recorder as { runBulkScreen?: unknown }).runBulkScreen = (req: BulkScreenRequest) =>
				(inner as BulkWasmSimRunner | BulkHttpSimRunner).runBulkScreen(req);
		}
		const ranking = await rankUpgrades(
			opts.input,
			{ ...opts.deps, sim: recorder, store: new MemoryStore(), concurrency: (inner as { concurrency: number }).concurrency } as never,
			progress => {
				if (progress && typeof progress === 'object' && 'stage' in progress && (progress as { stage: unknown }).stage === 'ranking') tail = true;
			},
		);
		return { seen, items: ranking.items };
	};

	const bulk = await runArm(true);
	const loop = await runArm(false);

	// D-2: replay one screening-phase request twice through the loop route.
	const sample = loop.seen.find(s => !s.tail);
	let replayA: SimObservation | undefined;
	let replayB: SimObservation | undefined;
	if (sample) {
		replayA = await opts.sim.run(sample.req, sample.opts);
		replayB = await opts.sim.run(sample.req, sample.opts);
	}

	const screenRuns = (arm: { seen: Seen[] }) => arm.seen.filter(s => !s.tail).length;
	const byId = (items: ReadonlyArray<{ itemId: number; deltaDps: number }>) => new Map(items.map(i => [i.itemId, i.deltaDps]));
	const b = byId(bulk.items);
	const l = byId(loop.items);
	const shared = [...l.keys()].filter(id => b.has(id));
	const differing = shared.filter(id => b.get(id) !== l.get(id));

	return {
		summary: {
			bulkArmScreenRuns: screenRuns(bulk),
			loopArmScreenRuns: screenRuns(loop),
			rows: { bulk: bulk.items.length, loop: loop.items.length, shared: shared.length },
			deltasDiffering: differing.length,
			replayIdentical: replayA && replayB ? replayA.dps === replayB.dps : null,
			replayDps: replayA && replayB ? [replayA.dps, replayB.dps] : null,
			sampleOriginalDps: sample?.obs.dps ?? null,
			verdict:
				differing.length === 0 && screenRuns(bulk) < screenRuns(loop) / 2
					? 'bulk arm screened via chunks yet matched the loop exactly'
					: differing.length === 0
						? 'both arms took the same path (bulk screening did not reduce run() calls)'
						: 'arms differ as expected',
		},
		detail: {
			firstDiffering: differing.slice(0, 5).map(id => ({ itemId: id, bulk: b.get(id), loop: l.get(id) })),
			sampleSeed: sample?.opts.seed ?? null,
			sampleIterations: sample?.opts.iterations ?? null,
		},
	};
}
