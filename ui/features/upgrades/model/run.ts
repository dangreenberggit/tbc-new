import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import type { WorkerPoolSimRunner } from './adapters/worker_pool_sim_runner';
import type { RankedItem } from './engine/rank';
import type { MemoryStore } from './engine/seams/store';
import type { RunResult, RunSettings } from './run_reducer';

/** The sim runner and the cache one mounted tab keeps across its runs. */
export type RunContext = {
	simRunner: WorkerPoolSimRunner;
	store: MemoryStore;
	terminate(): void;
};

export type RunDeps = {
	signal: AbortSignal;
	onLanded: (row: RankedItem) => void;
	/** Builds the run context on first call and returns the same one after. */
	runContext: () => RunContext;
};

export type RunFn = (host: IndividualSimHost<Spec>, settings: RunSettings, deps: RunDeps) => Promise<RunResult>;
