import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { describe, expect, it } from 'vitest';

import { setBonusTipLines, type TipLabel } from '../model/set_bonus_tip';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import { setBonusSubLineText, setBonusTipText, tipLabelId, tipLabelText, tipSections } from './set_bonus_labels';

loadEnglishBundles();

const NBSP = ' ';
const crystalforge = { setName: 'Crystalforge Battlegear', threshold: 2 };
const lightbringer = { setName: 'Lightbringer Battlegear', threshold: 4 };

describe('setBonusTipText', () => {
	it('prints a receipt with signed figures and a marked total', () => {
		const tip = setBonusTipLines(fixtureRow(10), { ranking: RANKING_FIXTURE })!;
		expect(setBonusTipText(tip)).toEqual([
			{ type: 'line', id: 'item_stats', label: 'Item stats', value: '+22.8', total: false },
			{ type: 'line', id: 'breaks:Crystalforge Battlegear:2', label: `Breaks Crystalforge Battlegear${NBSP}2pc`, value: '-18.4', total: false },
			{ type: 'line', id: 'total', label: 'Total', value: '+4.4', total: true },
		]);
	});

	it('prints separate outcomes as more or less, with no sign, and the marker on the row’s figure', () => {
		const rows = setBonusTipText({
			subLine: 'hover_hint',
			kind: 'outcomes',
			entries: [
				{ type: 'heading', heading: 'set_potential_totals' },
				{ type: 'line', label: { kind: 'item_alone', name: 'Lightbringer Faceguard', broken: [] }, dps: -2.04 },
				{ type: 'line', label: { kind: 'pieces', form: 'stop', pieces: ['A', 'B'], threshold: 4, broken: [] }, dps: 12.96, marker: true },
			],
		});
		expect(rows).toEqual([
			{ type: 'heading', id: 'set_potential_totals', text: 'Separate outcomes with this item, not added' },
			{ type: 'line', id: 'item_alone', label: 'Lightbringer Faceguard alone', value: '2.0 DPS less', total: false },
			{ type: 'line', id: 'pieces:stop:4:A+B', label: 'With A and B (4pc)', value: '13.0 DPS more', marker: "this row's figure", total: false },
		]);
	});

	it('says a figure that was not measured could not be', () => {
		const rows = setBonusTipText({
			subLine: 'not_counted',
			kind: 'receipt',
			entries: [
				{ type: 'heading', heading: 'set_potential' },
				{ type: 'line', label: { kind: 'bonus', set: 'Lightbringer Battlegear', threshold: 2, have: 1 }, dps: undefined },
				{ type: 'line', label: { kind: 'total' }, dps: 4.42 },
			],
		});
		expect(rows.slice(0, 2)).toEqual([
			{ type: 'heading', id: 'set_potential', text: 'Set potential' },
			{ type: 'line', id: 'bonus:Lightbringer Battlegear:2', label: `Lightbringer Battlegear${NBSP}2pc (1/2)`, value: "couldn't measure", total: false },
		]);
	});
});

describe('the not-counted section (ticket 336)', () => {
	const malorne2 = { setName: 'Malorne Harness', threshold: 2 };
	const reachable = (set: string, threshold: number, pieces: string[], broken: Array<{ setName: string; threshold: number }> = []): TipLabel => ({
		kind: 'reachable',
		set,
		threshold,
		have: 0,
		pieces,
		broken,
	});

	it('prints each heading, and every line under it as more or less than the item alone', () => {
		const rows = setBonusTipText({
			subLine: 'hover_hint',
			kind: 'receipt',
			entries: [
				{ type: 'line', label: { kind: 'total' }, dps: 1.5 },
				{ type: 'heading', heading: 'not_counted_off' },
				{ type: 'line', label: reachable('Thunderheart Harness', 2, ['Thunderheart Leggings']), dps: 55.07, outcome: true },
				{ type: 'heading', heading: 'not_counted_no_gain' },
				{ type: 'line', label: reachable('Malorne Harness', 4, ['Greaves of Malorne']), dps: -19.5, outcome: true },
				{ type: 'heading', heading: 'not_counted' },
				{ type: 'line', label: reachable('Malorne Harness', 2, ['Breastplate of Malorne']), dps: undefined, outcome: true },
			],
		});
		expect(rows).toEqual([
			{ type: 'line', id: 'total', label: 'Total', value: '+1.5', total: true },
			{ type: 'heading', id: 'not_counted_off', text: 'Not counted (Set potential is off)' },
			{
				type: 'line',
				id: 'reachable:Thunderheart Harness:2',
				label: `Thunderheart Harness${NBSP}2pc with Thunderheart Leggings`,
				value: '55.1 DPS more',
				total: false,
			},
			{ type: 'heading', id: 'not_counted_no_gain', text: 'Not counted (no gain over the item alone)' },
			{
				type: 'line',
				id: 'reachable:Malorne Harness:4',
				label: `Malorne Harness${NBSP}4pc with Greaves of Malorne`,
				value: '19.5 DPS less',
				total: false,
			},
			{ type: 'heading', id: 'not_counted', text: 'Not counted' },
			{
				type: 'line',
				id: 'reachable:Malorne Harness:2',
				label: `Malorne Harness${NBSP}2pc with Breastplate of Malorne`,
				value: "couldn't measure",
				total: false,
			},
		]);
	});

	it.each([
		// Mock-up row 1, toggle off: the 4pc breaks the worn Malorne 2pc.
		[
			reachable('Thunderheart Harness', 4, ['Thunderheart Pauldrons', 'Thunderheart Chestguard', 'Thunderheart Leggings'], [malorne2]),
			`Thunderheart Harness${NBSP}4pc with Thunderheart Pauldrons, Thunderheart Chestguard and Thunderheart Leggings, breaks Malorne Harness${NBSP}2pc`,
		],
		// Mock-up row 5, toggle off.
		[
			reachable('Malorne Harness', 4, ['Mantle of Malorne', 'Breastplate of Malorne', 'Greaves of Malorne']),
			`Malorne Harness${NBSP}4pc with Mantle of Malorne, Breastplate of Malorne and Greaves of Malorne`,
		],
		[{ kind: 'screened', set: 'Nordrassil Harness', reason: 'outside-band' } as TipLabel, 'Nordrassil Harness set bonuses (screened out)'],
	])('prints %j', (label, text) => {
		expect(tipLabelText(label)).toBe(text);
	});

	it.each([
		['outside-band', 'not measured'],
		['exact-zero', 'no effect in the sim'],
		['below-zero', 'a loss with its pieces'],
	] as const)('says what the screen found for a dropped set (%s), with no figure', (reason, value) => {
		const [row] = setBonusTipText({
			subLine: 'hover_hint',
			kind: 'receipt',
			entries: [{ type: 'line', label: { kind: 'screened', set: 'Burning Rage', reason }, dps: undefined }],
		});
		expect(row).toEqual({ type: 'line', id: 'screened:Burning Rage', label: 'Burning Rage set bonuses (screened out)', value, total: false });
	});
});

describe('tipLabelText', () => {
	const cases: Array<[TipLabel, string]> = [
		[{ kind: 'item_stats', bonus: lightbringer, unmeasuredBreaks: [] }, `Item stats + Lightbringer Battlegear${NBSP}4pc`],
		[{ kind: 'item_stats', unmeasuredBreaks: [crystalforge] }, `Item stats − Crystalforge Battlegear${NBSP}2pc`],
		[
			{ kind: 'item_stats', bonus: lightbringer, unmeasuredBreaks: [crystalforge] },
			`Item stats + Lightbringer Battlegear${NBSP}4pc − Crystalforge Battlegear${NBSP}2pc`,
		],
		[{ kind: 'breaks', broken: [crystalforge, lightbringer] }, `Breaks Crystalforge Battlegear${NBSP}2pc and Lightbringer Battlegear${NBSP}4pc`],
		[{ kind: 'piece_stats', name: 'Lightbringer Greaves' }, 'Lightbringer Greaves stats'],
		[
			{ kind: 'pieces', form: 'step', pieces: ['A', 'B', 'C'], threshold: 4, broken: [crystalforge] },
			`A, B and C (4pc, breaks Crystalforge Battlegear${NBSP}2pc)`,
		],
		[{ kind: 'item_alone', name: 'X', broken: [crystalforge] }, `X alone (breaks Crystalforge Battlegear${NBSP}2pc)`],
	];
	it.each(cases)('prints %j', (label, text) => {
		expect(tipLabelText(label)).toBe(text);
	});
});

describe('setBonusSubLineText', () => {
	it('prints the DPS cell’s hint line', () => {
		expect(setBonusSubLineText('hover_hint')).toBe('set detail');
	});
});

describe('tipSections', () => {
	it('starts a new section at each heading and keeps the lines before the first heading in an untitled one', () => {
		const line = (label: string) => ({ type: 'line' as const, id: label, label, value: '+1.0', total: false });
		const sections = tipSections([line('a'), { type: 'heading', id: 'set_potential', text: 'Set potential' }, line('b'), line('c')]);
		expect(sections).toEqual([
			{ id: 'lines', lines: [line('a')] },
			{ id: 'set_potential', heading: 'Set potential', lines: [line('b'), line('c')] },
		]);
	});

	it('gives a popover that opens on a heading no untitled section', () => {
		expect(tipSections([{ type: 'heading', id: 'set_potential_totals', text: 'Outcomes' }])).toEqual([
			{ id: 'set_potential_totals', heading: 'Outcomes', lines: [] },
		]);
	});
});

describe('tipLabelId', () => {
	it('names a line by the bonus, piece or set it is about', () => {
		expect(tipLabelId({ kind: 'breaks', broken: [crystalforge, lightbringer] })).toBe('breaks:Crystalforge Battlegear:2+Lightbringer Battlegear:4');
		expect(tipLabelId({ kind: 'piece_stats', name: 'Lightbringer Greaves' })).toBe('piece:Lightbringer Greaves');
	});

	it('numbers a second line about the same thing, so every row of a popover has its own id', () => {
		const breaks = { type: 'line' as const, label: { kind: 'breaks' as const, broken: [crystalforge] }, dps: -1 };
		const rows = setBonusTipText({
			subLine: 'hover_hint',
			kind: 'receipt',
			entries: [breaks, breaks, { type: 'line', label: { kind: 'total' }, dps: -2 }],
		});
		expect(rows.map(row => row.id)).toEqual(['breaks:Crystalforge Battlegear:2', 'breaks:Crystalforge Battlegear:2#2', 'total']);
	});
});
