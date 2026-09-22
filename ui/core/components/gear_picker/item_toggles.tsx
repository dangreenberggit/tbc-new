import tippy from 'tippy.js';
import { ref } from 'tsx-vanilla';

import { trackEvent } from '../../../tracking/utils';
import { IndividualSimUI } from '../../individual_sim_ui';
import { ItemSpec } from '../../proto/common';
import { DatabaseFilters } from '../../proto/ui';
import { Sim } from '../../sim';
import { TypedEvent } from '../../typed_event';

/**
 * The favorite star and the add-to-Batch-Sim button, as one module both the
 * gear picker's item list and the Upgrades tab's results tables build their
 * row controls from (ticket 472).
 *
 * Extracted from `item_list.tsx`'s two private closures with the class names,
 * tippy copy and the single `trackEvent` call preserved exactly, so the gear
 * picker's markup, styling and analytics are unchanged and the Upgrades rows
 * inherit the same button rules by class name.
 */

/**
 * Which favorites list an item belongs in, and its key inside it. The gear
 * picker has five cases (items, enchants, three gem slots, random suffixes);
 * the Upgrades tab only ever passes `favoriteItems`.
 */
export interface FavoriteKey {
	method: keyof DatabaseFilters;
	id: number | string;
}

export function isFavorited(filters: DatabaseFilters, key: FavoriteKey): boolean {
	return (filters[key.method] as unknown[]).includes(key.id as never);
}

/**
 * Adds or removes `key` and publishes the result. `getFilters()` returns a
 * clone, so the mutation below is on a copy and only `setFilters` makes it
 * visible — which also fires `filtersChangeEmitter`.
 */
export function setFavorited(sim: Sim, key: FavoriteKey, on: boolean): void {
	const filters = sim.getFilters();
	const list = filters[key.method] as unknown[];
	if (on) {
		list.push(key.id as never);
	} else {
		const idx = list.indexOf(key.id as never);
		if (idx !== -1) list.splice(idx, 1);
	}
	sim.setFilters(TypedEvent.nextEventID(), filters);
}

export interface ItemToggle {
	container: HTMLElement;
	button: HTMLButtonElement;
	refresh(): void;
}

export interface FavoriteToggle extends ItemToggle {
	isOn(): boolean;
}

// Lets `refreshToggles` repaint a button found by DOM query without the caller
// having to hold onto the handle that built it. Weak so a row removed from the
// DOM takes its entry with it.
const repaintFns = new WeakMap<HTMLButtonElement, () => void>();

/**
 * Repaints every toggle under `root` from current state. The Upgrades tab
 * calls this from two tab-level subscriptions rather than subscribing per row:
 * its rows are rebuilt on every landed row mid-run, so a per-row `.on()` would
 * accumulate listeners for rows that no longer exist.
 */
export function refreshToggles(root: ParentNode): void {
	for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-item-toggle]')) {
		repaintFns.get(button)?.();
	}
}

/**
 * A null `key` means this row has no favorites list (the gear picker's reforge
 * and other non-favoritable tabs): the star renders and does nothing, which is
 * what the closure this replaced did when its switch fell through.
 */
export function createFavoriteToggle(options: { sim: Sim; key: FavoriteKey | null }): FavoriteToggle {
	const { sim, key } = options;
	const buttonRef = ref<HTMLButtonElement>();
	const iconRef = ref<HTMLElement>();

	const container = (
		<div className="selector-modal-list-item-favorite-container">
			<button
				ref={buttonRef}
				className="selector-modal-list-item-favorite btn btn-link p-0"
				dataset={{ itemToggle: 'favorite', itemId: String(key?.id ?? '') }}>
				<i ref={iconRef} className="far fa-star fa-xl" />
			</button>
		</div>
	) as HTMLElement;

	const button = buttonRef.value!;
	const icon = iconRef.value!;
	const tooltip = tippy(button);

	// Read from the sim rather than a cached snapshot so a favorite toggled
	// elsewhere (the other table, the gear modal) repaints correctly.
	const isOn = () => (key ? isFavorited(sim.getFilters(), key) : false);

	const refresh = () => {
		const on = isOn();
		button.classList[on ? 'add' : 'remove']('text-brand');
		icon.classList[on ? 'add' : 'remove']('fas');
		icon.classList[on ? 'remove' : 'add']('far');
		const label = on ? 'Remove from favorites' : 'Add to favorites';
		tooltip.setContent(label);
		button.setAttribute('aria-label', label);
	};

	button.addEventListener('click', () => {
		// setFavorited then refresh, in that order and synchronously: the click
		// handler repaints its own star before `filtersChangeEmitter` reaches any
		// listener, so the star is correct no matter what those listeners do.
		if (!key) return;
		setFavorited(sim, key, !isOn());
		refresh();
	});

	repaintFns.set(button, refresh);
	refresh();

	return { container, button, refresh, isOn };
}

export function createBatchToggle(options: { simUI: IndividualSimUI<any>; itemId: number; subscribe: boolean }): ItemToggle {
	const { simUI, itemId, subscribe } = options;
	const buttonRef = ref<HTMLButtonElement>();

	const container = (
		<div className="selector-modal-list-item-compare-container hide">
			<button
				ref={buttonRef}
				className="selector-modal-list-item-compare btn btn-link p-0"
				dataset={{ itemToggle: 'batch', itemId: String(itemId) }}>
				<i className="fas fa-arrow-right-arrow-left fa-xl" />
			</button>
		</div>
	) as HTMLElement;

	const button = buttonRef.value!;
	const tooltip = tippy(button);
	const hasItem = () => !!simUI.bt?.hasItem(ItemSpec.create({ id: itemId }));

	const refresh = () => {
		const on = hasItem();
		const label = on ? 'Remove from Batch Sim' : 'Add to Batch Sim';
		tooltip.setContent(label);
		button.setAttribute('aria-label', label);
		button.classList[on ? 'add' : 'remove']('text-brand');
	};

	button.addEventListener('click', () => {
		const on = hasItem();
		simUI.bt?.[on ? 'removeItem' : 'addItem'](ItemSpec.create({ id: itemId }));
		trackEvent({
			action: 'click',
			category: 'batch',
			label: on ? 'remove-item' : 'add-item',
		});
	});

	// The gear picker subscribes per row, as it always has. The Upgrades tab
	// passes false and refreshes through one tab-level subscription instead.
	if (subscribe) simUI.bt?.itemsChangedEmitter.on(() => refresh());

	repaintFns.set(button, refresh);
	refresh();
	// The container starts hidden for parity with the gear picker, where
	// `bindToggleCompare` reveals it only on the Items tab.
	if (simUI.bt) container.classList.remove('hide');

	return { container, button, refresh };
}
