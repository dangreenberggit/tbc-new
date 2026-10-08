import { ItemQuality } from '@generated/proto/common';
import i18n from '@i18n/config';
import { render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../../assets/locales/en/upgrades.json';
import type { RankedItem } from '../../model/engine/rank';
import { type RowTag, rowTagIndex, type SetOption } from '../../model/settings_pool';
import { fixtureRow } from '../../testing/ranking_fixture';

// The icon lookup fetches from wowhead; the cell's text is under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ItemNameCell } = await import('./ItemNameCell');

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
beforeAll(() => i18n.addResourceBundle('en', 'upgrades', upgradesTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterAll(() => i18n.removeResourceBundle('en', 'upgrades'));

const set = (key: string, name: string, phase: number | undefined, itemIds: number[]): SetOption => ({
	key,
	name,
	label: name,
	phase,
	kind: phase === undefined ? 'saved' : 'preset',
	itemIds,
	inPool: itemIds.length,
});

const badgesOf = (row: RankedItem, tags: readonly RowTag[]) => {
	const { container } = render(
		<table>
			<tbody>
				<tr>
					<ItemNameCell row={row} quality={ItemQuality.ItemQualityEpic} tags={tags} />
				</tr>
			</tbody>
		</table>,
	);
	return within(container)
		.queryAllByTestId('upgrades-bis-badge')
		.map(badge => badge.textContent);
};

const torch = fixtureRow(0);

describe('ItemNameCell badges', () => {
	it('shows one badge per selected set that holds the item, in place of the BiS tag', () => {
		const tagsOf = rowTagIndex([set('preset:3:P3', 'P3', 3, [torch.itemId]), set('saved:Mine', 'Mine', undefined, [torch.itemId])]);
		expect(badgesOf(torch, tagsOf(torch.itemId))).toEqual(['P3', 'Mine']);
	});

	it('puts the phase in front when two selected sets share a name', () => {
		const tagsOf = rowTagIndex([set('preset:2:BiS', 'BiS', 2, [torch.itemId]), set('preset:3:BiS', 'BiS', 3, [torch.itemId])]);
		expect(badgesOf(torch, tagsOf(torch.itemId))).toEqual(['P2 BiS', 'P3 BiS']);
	});

	it('keeps the list’s own BiS or Alt badge on a row in no selected set', () => {
		expect(badgesOf(torch, [])).toEqual(['BiS']);
		expect(badgesOf(fixtureRow(7), [])).toEqual(['Alt']);
		expect(badgesOf(fixtureRow(1), [])).toEqual([]);
	});
});
