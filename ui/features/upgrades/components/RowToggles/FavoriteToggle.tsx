import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import clsx from 'clsx';
import { useStore } from 'zustand';

/**
 * The gear picker's favourite star for one result row, writing the sim's own
 * favourites. It subscribes on its own, so a memoised row does not render again
 * when favourites change, and through zustand, not `useStoreSubscribe`, which
 * answers a prop-keyed read one notification late.
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
			aria-label={i18n.t('upgrades_tab.results.favorite', { ns: 'upgrades' })}
			aria-pressed={favourite}
			title={i18n.t(favourite ? 'upgrades_tab.toggles.favorite_remove' : 'upgrades_tab.toggles.favorite_add', { ns: 'upgrades' })}
			className={clsx('w-8', favourite && 'text-brand')}
			data-testid="upgrades-favorite-toggle"
			onClick={toggle}>
			<Icon name="star" style={favourite ? 'solid' : 'regular'} size="xl" />
		</Button>
	);
};
