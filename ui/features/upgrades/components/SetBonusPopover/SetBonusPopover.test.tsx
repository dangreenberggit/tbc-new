import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SetBonusTip } from '../../model/set_bonus_tip';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The engine reads set membership from the sim database, which a unit test does not load.
vi.mock('../../model/engine/items', async importOriginal => ({
	...(await importOriginal<typeof import('../../model/engine/items')>()),
	getItem: () => ({ setId: null, setName: null }),
}));

const { SetBonusPopover } = await import('./SetBonusPopover');
const { setBonusTipLines } = await import('../../model/set_bonus_tip');

loadEnglishBundles();

const FACEGUARD_TIP = setBonusTipLines(fixtureRow(10), { ranking: RANKING_FIXTURE });

const show = (tip: SetBonusTip | null, figure = '+4.4') => {
	if (!tip) throw new Error('the fixture row has no popover');
	render(
		<table>
			<tbody>
				<tr>
					<td>
						<SetBonusPopover tip={tip}>{figure}</SetBonusPopover>
					</td>
				</tr>
			</tbody>
		</table>,
	);
	return screen.getByRole('button', { name: figure });
};

/** The popover opens once the pointer rests on the figure, as upstream's hover popovers do. A browser fires `pointerenter` before the mouse events. */
const hover = (trigger: HTMLElement) => {
	vi.useFakeTimers();
	fireEvent.pointerEnter(trigger);
	fireEvent.mouseEnter(trigger);
	fireEvent.mouseMove(trigger);
	act(() => vi.advanceTimersByTime(1000));
};
afterEach(() => vi.useRealTimers());

const popupLines = () =>
	within(screen.getByTestId('upgrades-set-bonus-tip'))
		.getAllByRole('term')
		.map(term => `${term.textContent} ${term.nextElementSibling?.textContent}`);

describe('SetBonusPopover', () => {
	it('opens when the pointer rests on the figure', () => {
		const trigger = show(FACEGUARD_TIP);
		expect(screen.queryByTestId('upgrades-set-bonus-tip')).toBeNull();

		hover(trigger);
		expect(screen.getByTestId('upgrades-set-bonus-tip')).toBeTruthy();
	});

	it('opens from the keyboard, because the figure is the popover’s button', () => {
		const trigger = show(FACEGUARD_TIP);
		trigger.focus();
		fireEvent.click(trigger);
		expect(screen.getByTestId('upgrades-set-bonus-tip')).toBeTruthy();
	});

	it('itemises the figure: the item’s stats, the bonus its swap breaks, and the total', () => {
		hover(show(FACEGUARD_TIP));

		expect(popupLines()).toEqual(['Item stats +22.8', 'Breaks Crystalforge Battlegear 2pc -18.4', 'Total +4.4']);
		expect(screen.getByTestId('upgrades-set-bonus-tip-total').textContent).toBe('Total+4.4');
	});

	it('names its dialog, so a screen reader says what opened', () => {
		hover(show(FACEGUARD_TIP));
		expect(screen.getByRole('dialog', { name: 'Set-bonus breakdown' })).toBe(screen.getByTestId('upgrades-set-bonus-tip'));
	});

	describe('opens right of the figure when the popup fits there, above it otherwise (ticket 495)', () => {
		/** Puts the figure's right edge `room` px short of the window's right edge. */
		const withRoom = (trigger: HTMLElement, room: number) => {
			const right = window.innerWidth - room;
			trigger.getBoundingClientRect = () => DOMRect.fromRect({ x: right - 40, y: 100, width: 40, height: 20 });
		};
		const side = () => screen.getByTestId('sim-popover-positioner').getAttribute('data-side');

		it('right, with room for the widest popup', () => {
			const trigger = show(FACEGUARD_TIP);
			withRoom(trigger, 600);
			hover(trigger);
			expect(side()).toBe('right');
		});

		it('above, when the widest popup would not fit to the right', () => {
			const trigger = show(FACEGUARD_TIP);
			withRoom(trigger, 300);
			hover(trigger);
			expect(side()).toBe('top');
		});

		// The widest popup needs 30rem (480 px) + the 10 px gap + the 6 px margin Base UI's flip keeps from the window's
		// edge (its default 5 px collisionPadding plus 1 px): 496 px. With less, Base UI would flip it to the left.
		it('right, at exactly the room the widest popup needs past Base UI’s collision margin', () => {
			const trigger = show(FACEGUARD_TIP);
			withRoom(trigger, 496);
			hover(trigger);
			expect(side()).toBe('right');
		});

		it('above, one pixel short of that room, where Base UI would flip a right-side popup to the left', () => {
			const trigger = show(FACEGUARD_TIP);
			withRoom(trigger, 495);
			hover(trigger);
			expect(side()).toBe('top');
		});

		it('measures from the keyboard too: right when opened with Enter and there is room', () => {
			const trigger = show(FACEGUARD_TIP);
			withRoom(trigger, 600);
			trigger.focus();
			fireEvent.click(trigger);
			expect(side()).toBe('right');
		});
	});

	it('marks the outcome a step ranking row’s figure uses, and adds no total', () => {
		const tip: SetBonusTip = {
			subLine: 'hover_hint',
			kind: 'outcomes',
			entries: [
				{ type: 'heading', heading: 'set_potential_totals' },
				{ type: 'line', label: { kind: 'item_alone', name: 'Lightbringer Faceguard', broken: [] }, dps: 4.4 },
				{
					type: 'line',
					label: { kind: 'pieces', form: 'stop', pieces: ['Lightbringer Chestguard'], threshold: 2, broken: [] },
					dps: 30.1,
					marker: true,
				},
			],
		};
		hover(show(tip));

		expect(within(screen.getByTestId('upgrades-set-bonus-tip')).getByText('Separate outcomes with this item, not added')).toBeTruthy();
		expect(popupLines()).toEqual(['Lightbringer Faceguard alone 4.4 DPS more', "With Lightbringer Chestguard (2pc)this row's figure 30.1 DPS more"]);
		expect(screen.queryByTestId('upgrades-set-bonus-tip-total')).toBeNull();
	});
});
