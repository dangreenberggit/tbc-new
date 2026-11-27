/**
 * Replicate seeds: the seeds the replication sims run at, and the guard on seeds closer than
 * the iteration count, on the model sim of `testing/set_bonus_scenario.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { runScenario, SR_SCENARIO } from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

describe('Replicate seeds', () => {
	it('with no seeds, the five replicates run at 11 + k × iterations', async () => {
		const run = await runScenario({
			...SR_SCENARIO,
			setScreenMode: 'on',
			seeds: 'engine-default',
			iterations: 3000,
		});
		expect(run.ranking.items.some(r => r.seMethod === 'paired-replicate')).toBe(true);
		const seeds = [...new Set(run.callOpts.map(o => o.seed))].sort((a, b) => a - b);
		expect(seeds).toEqual([11, 3011, 6011, 9011, 12011]);
		expect(run.ranking.assumptions.seeds).toEqual([11, 3011, 6011, 9011, 12011]);
	}, 120_000);

	it('seeds closer than the iteration count are refused', async () => {
		const err: unknown = await runScenario({
			...SR_SCENARIO,
			seeds: [11, 22],
			iterations: 3000,
		}).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toMatchObject({ name: 'RankError', kind: 'internal' });
		expect((err as Error).message).toMatch(/at least 3000 apart/);
		const boundary = await runScenario({
			...SR_SCENARIO,
			seeds: [11, 3011],
			iterations: 3000,
		});
		expect(boundary.ranking.complete).toBe(true);
	}, 120_000);
});
