import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { assumptionsLine } from './assumptions';

describe('assumptionsLine', () => {
	it('names the seeds, iterations and phase of a ranking with nothing else known, as for a loaded fixture', () => {
		expect(assumptionsLine(RANKING_FIXTURE)).toBe('[upgrades] assumptions — seeds: 11, 22, 33, 44, 55 · iterations: 3000 · max phase: 3');
	});

	it('names the run’s pool settings when the run is known', () => {
		const line = assumptionsLine(RANKING_FIXTURE, {
			settings: { iterations: 3000, candidateCap: 40, excludedSources: ['Black Temple', 'pvp'], guaranteedSetKeys: ['p3-bis'], prune: true },
		});
		expect(line).toContain(' · candidate pool: BiS-list items for phase 3');
		expect(line).toContain(' · candidate cap: top 40 simmed in full, plus anything you already own');
		expect(line).toContain(' · sources: excluded Black Temple, pvp');
		expect(line).toContain(' · sets: p3-bis');
	});

	it('says every source and no set when the run filtered nothing', () => {
		const line = assumptionsLine(RANKING_FIXTURE, { settings: { iterations: 3000 } });
		expect(line).toContain(' · candidate pool: every eligible item');
		expect(line).toContain(' · sources: all · sets: none');
		expect(line).not.toContain('candidate cap');
	});

	it('names the bundled pool file the spec’s run drew from', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { specId: 'ret' })).toMatch(/ · pool source: ret-p3\.universe\.json \(\d+ entries\)/);
	});
});
