import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import clsx from 'clsx';
import { useStore } from 'zustand';

/**
 * The gear picker's favorite star for one result row, writing the sim's own
 * favorites. It subscribes on its own, so a memoized row does not render again
 * when favorites change, and through zustand, not `useStoreSubscribe`, which
 * answers a read keyed by a prop one notification late.
 */
export const FavoriteToggle = ({ itemId }: { itemId: number }) => {
	const { sim } = useSimHost();
	const favorite = useStore(sim.store, state => state.sim.filters.favoriteItems.includes(itemId));

	const toggle = () => {
		const next = sim.getFilters();
		next.favoriteItems = favorite ? next.favoriteItems.filter(id => id !== itemId) : [...next.favoriteItems, itemId];
		sim.setFilters(next);
	};

	return (
		<Button
			iconOnly
			aria-label={i18n.t('upgrades_tab.results.favorite', { ns: 'upgrades' })}
			aria-pressed={favorite}
			title={i18n.t(favorite ? 'upgrades_tab.toggles.favorite_remove' : 'upgrades_tab.toggles.favorite_add', { ns: 'upgrades' })}
			className={clsx('w-8', favorite && 'text-brand')}
			data-testid="upgrades-favorite-toggle"
			onClick={toggle}>
			<Icon name="star" style={favorite ? 'solid' : 'regular'} size="xl" />
		</Button>
	);
};
