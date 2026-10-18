/**
 * One Upgrades run on the live page: the page's gear and settings, the fork's
 * ranking engine, and the tab's own WASM worker pool. DOM-free; the browser
 * values the pool is sized from arrive as a `RunnerEnv`.
 */

import { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import { PlayerGearSource } from './adapters/player_gear_source';
import { simDatabaseResolverFor } from './adapters/sim_database';
import { currentPageSkeleton } from './adapters/skeleton';
import { type RunnerEnv, workerCountFor, WorkerPoolSimRunner } from './adapters/worker_pool_sim_runner';
import { epWeightsFor, poolFor } from './data/data';
import { type Progress, type RankedItem, RankError, type RankInput, rankUpgrades } from './engine/rank';
import { MemoryStore } from './engine/seams/store';
import type { ContentPhase, SpecId } from './engine/types';
import { emitProgress } from './progress_channel';
import { RUN_PROGRESS_ESTIMATOR, RUN_PROGRESS_MIN_CANDIDATES_DONE, RUN_PROGRESS_SHOW_FROM_FRACTION, RunProgressTracker } from './run_progress';
import type { RunOutcome, RunSettings } from './run_state';
import { effectivePool } from './settings_pool';

/** The sim runner and the cache one mounted tab keeps across its runs. */
export type RunContext = {
	simRunner: WorkerPoolSimRunner;
	store: MemoryStore;
};

export type RunDeps = {
	signal: AbortSignal;
	onLanded: (row: RankedItem) => void;
	/** Builds the run context on first call and returns the same one after. */
	runContext: () => RunContext;
};

export type RunFn = (host: IndividualSimHost<Spec>, settings: RunSettings, deps: RunDeps) => Promise<RunOutcome>;

/**
 * Which page spec the engine can rank, and under what name. `Partial` on
 * purpose: tanks and healers are not ranked, and a spec missing here is a
 * state the tab shows, not a gap to fill.
 */
const SPEC_ID_BY_PROTO_SPEC: Partial<Record<Spec, SpecId>> = {
	[Spec.SpecBalanceDruid]: 'balance',
	[Spec.SpecFeralCatDruid]: 'feral',
	[Spec.SpecHunter]: 'hunter',
	[Spec.SpecMage]: 'mage',
	[Spec.SpecRetributionPaladin]: 'ret',
	[Spec.SpecDpsPriest]: 'shadow',
	[Spec.SpecRogue]: 'rogue',
	[Spec.SpecElementalShaman]: 'ele',
	[Spec.SpecEnhancementShaman]: 'enh',
	[Spec.SpecWarlock]: 'warlock',
	[Spec.SpecDpsWarrior]: 'warrior',
};

export const specIdFor = (spec: Spec): SpecId | undefined => SPEC_ID_BY_PROTO_SPEC[spec];

/**
 * One runner and one store per mounted tab, not per run: the store's job is to
 * reuse identical sims across runs. Every runner on the page shares one worker
 * pool (`worker_pool_sim_runner.ts`).
 */
export function createRunContext(env: RunnerEnv): RunContext {
	const simRunner = new WorkerPoolSimRunner(workerCountFor(env), env.deviceMemoryGiB);
	return { simRunner, store: new MemoryStore() };
}

export const rankForPlayer: RunFn = async (host, settings, deps) => {
	const { simRunner, store } = deps.runContext();
	const startedAt = Date.now();

	const specId = specIdFor(host.player.getSpec());
	if (!specId) {
		throw new RankError('not-implemented', `no Upgrades data for spec ${Spec[host.player.getSpec()]}`);
	}

	await host.sim.waitForInit();
	const maxPhase = host.sim.getPhase() as ContentPhase;
	const skeleton = currentPageSkeleton(host);

	const tracker = new RunProgressTracker({
		estimator: RUN_PROGRESS_ESTIMATOR,
		showFromFraction: RUN_PROGRESS_SHOW_FROM_FRACTION,
		minCandidatesDone: RUN_PROGRESS_MIN_CANDIDATES_DONE,
	});
	tracker.setConcurrency(simRunner.concurrency);
	deps.signal.addEventListener('abort', () => tracker.noteStop(), { once: true });

	const onProgress = (progress: Progress) => {
		tracker.observe(progress, Date.now() - startedAt);
		if ('kind' in progress) deps.onLanded(progress.row);
		emitProgress(host.player, tracker.view());
	};

	const input: RankInput = {
		// The gear source ignores everything on this ref but its shape: this
		// surface has no logged character, only the page.
		character: { region: 'US', realm: 'current-page', name: host.player.getName() || 'player' },
		spec: specId,
		maxPhase,
		iterations: settings.iterations,
		candidateCap: settings.candidateCap,
	};

	const ranking = await rankUpgrades(
		input,
		{
			gear: new PlayerGearSource(host),
			sim: simRunner,
			store,
			clock: () => new Date(),
			raidSimSkeleton: skeleton,
			epWeights: epWeightsFor(specId),
			pool: effectivePool(poolFor(host, maxPhase), {
				excludedSources: settings.excludedSources ?? [],
				selectedSetItemIds: settings.guaranteedSetItemIds ?? [],
				prune: settings.prune ?? false,
			}),
			simDatabaseFor: simDatabaseResolverFor(host.player, skeleton),
			concurrency: simRunner.concurrency,
			signal: deps.signal,
			// The old tab's settings: a worn set bonus a swap breaks is measured
			// (ticket 467), and the set screen is on (ticket 511 K5ON, ADR-0035).
			measureBrokenSetValue: true,
			setScreen: 'on',
		},
		onProgress,
	);

	return { ...ranking, durationMs: Date.now() - startedAt, runner: 'WorkerPoolSimRunner' };
};
