import { describe, expect, it } from 'vitest';

import { dbPoolHost } from '../testing/db_pool';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { assumptionsLine, noteConsoleLines, noteFirstLine } from './assumptions';
import { epWeightsPresetFor } from './data/data';

describe('assumptionsLine', () => {
	it('names the seeds, iterations, phase and cutoff of a ranking with nothing else known, as for a loaded fixture', () => {
		expect(assumptionsLine(RANKING_FIXTURE)).toBe('[upgrades] assumptions — seeds: 11, 22, 33, 44, 55 · iterations: 3000 · max phase: 3 · cutoff: 3 DPS');
	});

	it('gives every spec the same flat cutoff, borrowed from no other spec', () => {
		for (const specId of ['ret', 'feral', 'warlock'] as const) {
			const line = assumptionsLine(RANKING_FIXTURE, { epWeightsPreset: specId });
			expect(line).toContain(' · cutoff: 3 DPS');
			expect(line).toContain(' · EP weights: written for ');
			expect(line).not.toContain('borrowed');
		}
	});

	// The Arms set was written for P3 and Fury's for P1, so the phase in the line shows which set the talents picked.
	it('says which phase an Arms or a Fury run’s EP weights were written for', () => {
		const rankingP4 = { ...RANKING_FIXTURE, assumptions: { ...RANKING_FIXTURE.assumptions, maxPhase: 4 as const } };
		expect(assumptionsLine(rankingP4, { epWeightsPreset: epWeightsPresetFor('warrior', [33, 28, 0]) })).toContain(
			' · EP weights: written for P3, ranking P4',
		);
		expect(assumptionsLine(rankingP4, { epWeightsPreset: epWeightsPresetFor('warrior', [21, 40, 0]) })).toContain(
			' · EP weights: written for P1, ranking P4',
		);
	});

	it('names the run’s pool settings when the run is known', () => {
		const line = assumptionsLine(RANKING_FIXTURE, {
			settings: { iterations: 3000, candidateCap: 40, excludedSources: ['Black Temple', 'pvp'], selectedGearSetKeys: ['p3-bis'], prune: true },
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

	// 1042: ret-p3 under include-unticked, measured like the cells of `pool_source.cells.fixture.json`; re-pin the way
	// `pool_source.test.ts` says.
	it('names the page’s database and the size of the pool the run drew from', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { epWeightsPreset: 'ret', host: dbPoolHost('ret') })).toContain(' · pool source: wowsims db (1042 entries)');
	});

	// A replayed run and a loaded fixture record no EP-weights preset, but the page's pool is still known.
	it('names the page’s pool and no EP weights when no set is known', () => {
		const line = assumptionsLine(RANKING_FIXTURE, { host: dbPoolHost('ret') });
		expect(line).toContain(' · pool source: wowsims db (1042 entries)');
		expect(line).not.toContain('EP weights');
	});

	it('leaves the pool lines out when the page is not known', () => {
		expect(assumptionsLine(RANKING_FIXTURE, { epWeightsPreset: 'ret' })).not.toContain('pool source');
	});
});

describe('noteFirstLine', () => {
	it('keeps a crash trace’s first line, whether its breaks are real or written out as backslash-n', () => {
		expect(noteFirstLine('panic: boom\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(noteFirstLine('panic: boom\\ngoroutine 1')).toEqual({ line: 'panic: boom', truncated: true });
		expect(noteFirstLine('Kept the worn hit gems.')).toEqual({ line: 'Kept the worn hit gems.', truncated: false });
	});

	it('does not count an empty error after the first line as cut text', () => {
		expect(noteFirstLine('Its sim failed.\n')).toEqual({ line: 'Its sim failed.', truncated: false });
		expect(noteFirstLine('Its sim failed.\n \n')).toEqual({ line: 'Its sim failed.', truncated: false });
		expect(noteConsoleLines([{ field: 'set', detail: 'Its sim failed.\n' }])).toEqual([]);
	});
});

describe('noteConsoleLines', () => {
	it("gives the full text of each reason the page shortened, and every failed call's error, which the page does not show", () => {
		expect(noteConsoleLines(RANKING_FIXTURE.substitutions)).toEqual([
			'[upgrades] Warglaive of Azzinoth: This item was not ranked in this slot, because its sim failed.\nitem 32837, slot mainhand\npanic: runtime error\ngoroutine 1 [running]:\nmain.main()',
		]);
		expect(noteConsoleLines([{ field: 'hit cap', detail: 'Kept the worn hit gems.' }])).toEqual([]);
		// The page shows no error, so each failure's whole error goes to the console.
		const failed = (error: string) => ({ field: 'set', detail: 'Its sim failed.', error });
		expect(noteConsoleLines([failed('HTTP 500 from /raidSimAsync')])).toEqual(['[upgrades] set: Its sim failed.\nHTTP 500 from /raidSimAsync']);
		expect(noteConsoleLines([failed(' \n')])).toEqual([]);
		expect(noteConsoleLines([failed('panic: boom\ngoroutine 7')])).toEqual(['[upgrades] set: Its sim failed.\npanic: boom\ngoroutine 7']);
	});
});
