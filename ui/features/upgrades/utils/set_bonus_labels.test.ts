import i18n from '@i18n/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../assets/locales/en/translation.json';
import { setBonusTipLines, type TipLabel } from '../model/set_bonus_tip';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import { setBonusSubLineText, setBonusTipText, tipLabelText } from './set_bonus_labels';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

const NBSP = ' ';
const crystalforge = { setName: 'Crystalforge Battlegear', threshold: 2 };
const lightbringer = { setName: 'Lightbringer Battlegear', threshold: 4 };

describe('setBonusTipText', () => {
	it('prints a receipt with signed figures and a marked total', () => {
		const tip = setBonusTipLines(fixtureRow(10), { ranking: RANKING_FIXTURE })!;
		expect(setBonusTipText(tip)).toEqual([
			{ type: 'line', label: 'Item stats', value: '+22.8', total: false },
			{ type: 'line', label: `Breaks Crystalforge Battlegear${NBSP}2pc`, value: '-18.4', total: false },
			{ type: 'line', label: 'Total', value: '+4.4', total: true },
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
			{ type: 'heading', text: 'Separate outcomes with this item, not added' },
			{ type: 'line', label: 'Lightbringer Faceguard alone', value: '2.0 DPS less', total: false },
			{ type: 'line', label: 'With A and B (4pc)', value: '13.0 DPS more', marker: "this row's figure", total: false },
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
			{ type: 'heading', text: 'Set potential' },
			{ type: 'line', label: `Lightbringer Battlegear${NBSP}2pc (1/2)`, value: "couldn't measure", total: false },
		]);
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
