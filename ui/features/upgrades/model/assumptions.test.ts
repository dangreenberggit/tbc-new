import { describe, expect, it } from 'vitest';

import { dbPoolHost } from '../testing/db_pool';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { assumptionsLine, substitutionConsoleLines, substitutionFirstLine } from './assumptions';

describe('assumptionsLine', () => {
	it('names the seeds, iterations, phase and cutoff of a ranking with nothing else known, as for a loaded fixture', () => {
		expect(assumptionsLine(RANKING_FIXTURE)).toBe('[upgrades] assumptions — seeds: 11, 22, 33, 44, 55 · iterations: 3000 · max phase: 3 · cutoff: 3 DPS');
	});

	it('gives every spec the same flat cutoff, borrowed from no other spec (ADR-0037)', () => {
		for (const specId of ['ret', 'feral', 'warlock'] as const) {
			const line = assumptionsLine(RANKING_FIXTURE, { specId });
			expect(line).toContain(' · cutoff: 3 DPS');
			expect(line).not.toContain('borrowed');
		}
	});

	it('names the run’s pool settings when the run is known', () => {
		const line = assumptionsLine(RANKING_FIXTURE, {
			settings: { iterations: 3000, candidateCap: 40, excludedSources: ['Black Temple', 'pvp'], guaranteedSetKeys: ['p3-bis'], prune: true },
		});
		expect(line).toContain(' · candidate pool: selected set items for phase 3');
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

	// 1044: ret-p3 under include-unticked, measured once by the independent script `pool_source.cells.fixture.json`'s
	// _comment describes, which no checkout holds; re-pin as that _comment says.
	it('names the page’s database and the size of the pool the run drew from', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { specId: 'ret', host: dbPoolHost('ret') })).toContain(' · pool source: wowsims db (1044 entries)');
	});

	it('leaves the pool lines out when the page is not known', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { specId: 'ret' })).not.toContain('pool source');
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
			'[upgrades] Warglaive of Azzinoth: This item was not ranked in this slot, because its sim failed.\nitem 32837, slot mainhand: panic: runtime error\ngoroutine 1 [running]:\nmain.main()',
		]);
		expect(substitutionConsoleLines([{ field: 'hit cap', detail: 'Kept the worn hit gems.' }])).toEqual([]);
	});
});
