import { describe, expect, it } from 'vitest';

import { dbPoolHost } from '../testing/db_pool';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { assumptionsLine, substitutionConsoleLines, substitutionFirstLine } from './assumptions';
import { epWeightsSetFor } from './data/data';

describe('assumptionsLine', () => {
	it('names the seeds, iterations, phase and cutoff of a ranking with nothing else known, as for a loaded fixture', () => {
		expect(assumptionsLine(RANKING_FIXTURE)).toBe('[upgrades] assumptions — seeds: 11, 22, 33, 44, 55 · iterations: 3000 · max phase: 3 · cutoff: 3 DPS');
	});

	it('gives every spec the same flat cutoff, borrowed from no other spec (ADR-0037)', () => {
		for (const specId of ['ret', 'feral', 'warlock'] as const) {
			const line = assumptionsLine(RANKING_FIXTURE, { epWeightsSet: specId });
			expect(line).toContain(' · cutoff: 3 DPS');
			expect(line).toContain(' · EP weights: written for ');
			expect(line).not.toContain('borrowed');
		}
	});

	// The Arms set was written for P3 and Fury's for P1 (ticket 803), so the phase in the line shows which set the talents picked.
	it('says which phase an Arms or a Fury run’s EP weights were written for', () => {
		const rankingP4 = { ...RANKING_FIXTURE, assumptions: { ...RANKING_FIXTURE.assumptions, maxPhase: 4 as const } };
		expect(assumptionsLine(rankingP4, { epWeightsSet: epWeightsSetFor('warrior', [33, 28, 0]) })).toContain(' · EP weights: written for P3, ranking P4');
		expect(assumptionsLine(rankingP4, { epWeightsSet: epWeightsSetFor('warrior', [21, 40, 0]) })).toContain(' · EP weights: written for P1, ranking P4');
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

	// 1042: ret-p3 under include-unticked (1044 before ticket 753 took one Sergeant's cape and cloak out), measured once by the independent script `pool_source.cells.fixture.json`'s
	// _comment describes, which no checkout holds; re-pin as that _comment says.
	it('names the page’s database and the size of the pool the run drew from', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { epWeightsSet: 'ret', host: dbPoolHost('ret') })).toContain(' · pool source: wowsims db (1042 entries)');
	});

	it('leaves the pool lines out when the page is not known', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { epWeightsSet: 'ret' })).not.toContain('pool source');
	});
});

describe('substitutionFirstLine', () => {
	it('keeps a crash trace’s first line, whether its breaks are real or written out as backslash-n', () => {
		expect(substitutionFirstLine('panic: boom\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(substitutionFirstLine('panic: boom\\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(substitutionFirstLine('Kept the worn hit gems.')).toEqual({ line: 'Kept the worn hit gems.', truncated: false });
	});

	it('does not count an empty error after the first line as cut text', () => {
		expect(substitutionFirstLine('Its sim failed.\n')).toEqual({ line: 'Its sim failed.', truncated: false });
		expect(substitutionFirstLine('Its sim failed.\n \n')).toEqual({ line: 'Its sim failed.', truncated: false });
		expect(substitutionConsoleLines([{ field: 'set', detail: 'Its sim failed.\n' }])).toEqual([]);
	});
});

describe('substitutionConsoleLines', () => {
	it("gives the full text of each reason the page shortened, and every failed call's error, which the page does not show", () => {
		expect(substitutionConsoleLines(RANKING_FIXTURE.substitutions)).toEqual([
			'[upgrades] Warglaive of Azzinoth: This item was not ranked in this slot, because its sim failed.\nitem 32837, slot mainhand\npanic: runtime error\ngoroutine 1 [running]:\nmain.main()',
		]);
		expect(substitutionConsoleLines([{ field: 'hit cap', detail: 'Kept the worn hit gems.' }])).toEqual([]);
		// Owner's ruling 2026-11-11: the page shows no error, so each failure's whole error goes to the console.
		const failed = (error: string) => ({ field: 'set', detail: 'Its sim failed.', error });
		expect(substitutionConsoleLines([failed('HTTP 500 from /raidSimAsync')])).toEqual(['[upgrades] set: Its sim failed.\nHTTP 500 from /raidSimAsync']);
		expect(substitutionConsoleLines([failed(' \n')])).toEqual([]);
		expect(substitutionConsoleLines([failed('panic: boom\ngoroutine 7')])).toEqual(['[upgrades] set: Its sim failed.\npanic: boom\ngoroutine 7']);
	});
});
