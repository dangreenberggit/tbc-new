import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { assumptionsLine, substitutionConsoleLines, substitutionFirstLine } from './assumptions';

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

describe('substitutionFirstLine', () => {
	it('keeps a crash trace’s first line, whether its breaks are real or written out as backslash-n', () => {
		expect(substitutionFirstLine('panic: boom\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(substitutionFirstLine('panic: boom\\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(substitutionFirstLine('Kept the worn hit gems.')).toEqual({ line: 'Kept the worn hit gems.', truncated: false });
	});
});

describe('substitutionConsoleLines', () => {
	it('gives the full text of each reason the page shortened, for the console the page points to', () => {
		expect(substitutionConsoleLines(RANKING_FIXTURE.substitutions)).toEqual([
			'[upgrades] candidate 32837 (mainhand): Warglaive of Azzinoth was dropped from the ranking: the sim failed on this swap — panic: runtime error\ngoroutine 1 [running]:\nmain.main()',
		]);
		expect(substitutionConsoleLines([{ field: 'hit cap', detail: 'Kept the worn hit gems.' }])).toEqual([]);
	});
});
