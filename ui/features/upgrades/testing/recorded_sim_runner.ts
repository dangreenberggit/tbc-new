/** A `SimRunner` that replays recorded sim results by their cache key, for tests. */

import {
	type PlayerStatsObservation,
	type RaidSimRequest,
	simCacheKey,
	type SimObservation,
	type SimRunner,
	type SimRunOpts,
} from '../model/engine/seams/sim-runner';

export class RecordedSimRunner implements SimRunner {
	constructor(
		private readonly simVersion: string,
		private readonly recordings: ReadonlyMap<string, SimObservation>,
	) {}

	async version(): Promise<string> {
		return this.simVersion;
	}

	async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
		const key = simCacheKey(req, this.simVersion, opts);
		const hit = this.recordings.get(key);
		if (!hit) {
			throw new Error(`no recording for sim key ${key}`);
		}
		return hit;
	}

	/** Recordings hold sim results only, so a spec with a hit budget fails here. */
	async computeStats(): Promise<PlayerStatsObservation> {
		throw new Error('RecordedSimRunner has no recorded stats reads');
	}
}
