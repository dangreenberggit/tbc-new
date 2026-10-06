import i18n from '@i18n/config';
import { fireEvent, render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { applyView } from '../../model/engine/view';
import { stoppedView } from '../../model/results_view';
import { RANKING_FIXTURE, STOPPED_FIXTURE } from '../../testing/ranking_fixture';

vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultsPanes } = await import('./ResultsPanes');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const CONTEXT = { itemOf: () => undefined, tip: {} };
const VIEW = applyView(RANKING_FIXTURE);

const tabStrip = (container: HTMLElement) => within(within(container).getByTestId('upgrades-tab-tabs'));
const tabLabels = (container: HTMLElement) =>
	tabStrip(container)
		.getAllByRole('tab')
		.map(tab => tab.textContent);
const clickTab = (container: HTMLElement, label: string) => fireEvent.click(tabStrip(container).getByRole('tab', { name: new RegExp(`^${label}`) }));
const activePane = (container: HTMLElement) => {
	const panes = [...container.querySelectorAll<HTMLElement>('[data-testid="tab-pane"]')].filter(pane => !pane.hidden && !pane.hasAttribute('inert'));
	expect(panes).toHaveLength(1);
	return panes[0]!;
};
const namesIn = (pane: HTMLElement) =>
	within(pane)
		.queryAllByTestId('upgrades-item-name')
		.map(name => name.textContent);

describe('ResultsPanes', () => {
	it('offers the Upgrades list and one tab per slot with a row, in slot order, counting each slot’s shortlist', () => {
		const { container } = render(<ResultsPanes view={VIEW} rowContext={CONTEXT} />);
		expect(tabLabels(container)).toEqual(['Upgrades', 'Head (2)', 'Chest (2)', 'Legs (1)', 'Trinket 1 (1)', 'Main Hand (4)']);
	});

	it('links each tab to its own pane', () => {
		const { container } = render(<ResultsPanes view={VIEW} rowContext={CONTEXT} />);
		for (const tab of tabStrip(container).getAllByRole('tab')) {
			const paneId = tab.getAttribute('aria-controls');
			expect(paneId).toMatch(/^upgrades-pane-/);
			expect(container.querySelector(`#${paneId}`)?.getAttribute('data-testid')).toBe('tab-pane');
		}
	});

	it('opens on the Upgrades list and shows a slot’s rows when its tab is clicked', () => {
		const { container } = render(<ResultsPanes view={VIEW} rowContext={CONTEXT} />);
		expect(namesIn(activePane(container))).toHaveLength(VIEW.shortlist.length);

		clickTab(container, 'Head');
		expect(namesIn(activePane(container))).toEqual(['Cursed Vision of Sargeras', 'Lightbringer Faceguard']);
	});

	it('applies a sort chosen in one pane to every pane', () => {
		const { container } = render(<ResultsPanes view={VIEW} rowContext={CONTEXT} />);
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));
		fireEvent.click(within(activePane(container)).getByTestId('upgrades-sort-item'));

		clickTab(container, 'Main Hand');
		expect(namesIn(activePane(container))).toEqual([
			"Cataclysm's Edge",
			'Torch of the Damned',
			'Twinblade of the Phoenix',
			"Vengeful Gladiator's Greatsword",
		]);
	});

	it('falls back to the Upgrades list when the open slot has no rows in a new result', () => {
		const { container, rerender } = render(<ResultsPanes view={VIEW} rowContext={CONTEXT} />);
		clickTab(container, 'Legs');
		expect(namesIn(activePane(container))).toEqual(['Lightbringer Greaves']);

		const withoutLegs = stoppedView({ ...STOPPED_FIXTURE, items: STOPPED_FIXTURE.items.filter(row => row.slot !== 'legs') });
		rerender(<ResultsPanes view={withoutLegs} rowContext={CONTEXT} />);
		expect(tabLabels(container)).not.toContain('Legs (1)');
		expect(namesIn(activePane(container))).toHaveLength(withoutLegs.shortlist.length);
	});
});
