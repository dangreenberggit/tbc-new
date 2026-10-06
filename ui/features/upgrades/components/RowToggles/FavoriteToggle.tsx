import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import clsx from 'clsx';
import { useStore } from 'zustand';

/**
 * The gear picker's favourite star for one result row: it writes the sim's
 * own favourites, so the item is starred in the picker too. It subscribes on
 * its own, so a memoised row does not render again when favourites change.
 * Read through zustand, not `useStoreSubscribe`: the answer is keyed by a
 * prop, which that hook answers one notification late (its own comment).
 */
export const FavoriteToggle = ({ itemId }: { itemId: number }) => {
	const { sim } = useSimHost();
	const favourite = useStore(sim.store, state => state.sim.filters.favoriteItems.includes(itemId));

	const toggle = () => {
		const next = sim.getFilters();
		next.favoriteItems = favourite ? next.favoriteItems.filter(id => id !== itemId) : [...next.favoriteItems, itemId];
		sim.setFilters(next);
	};

	return (
		<Button
			iconOnly
			aria-label={i18n.t('upgrades_tab.results.favorite')}
			aria-pressed={favourite}
			title={i18n.t(favourite ? 'upgrades_tab.toggles.favorite_remove' : 'upgrades_tab.toggles.favorite_add')}
			className={clsx('w-8', favourite && 'text-brand')}
			data-testid="upgrades-favorite-toggle"
			onClick={toggle}>
			<Icon name="star" style={favourite ? 'solid' : 'regular'} size="xl" />
		</Button>
	);
};
