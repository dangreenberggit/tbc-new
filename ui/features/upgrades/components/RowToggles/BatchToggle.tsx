import { useBulkState } from '@features/bulk/hooks/useBulkState';
import { addBulkItem, removeBulkItem } from '@features/bulk/model/items';
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import clsx from 'clsx';

/**
 * The gear picker's batch button for one result row: it adds the plain item
 * to the Batch Sim list, or takes it out. The read and the removal both match
 * the exact spec, so a gemmed copy batched elsewhere does not read as this
 * row's, which a click could not remove.
 */
export const BatchToggle = ({ itemId }: { itemId: number }) => {
	const { player } = useSimHost();
	const spec = ItemSpec.create({ id: itemId });
	const inBatch = useBulkState(slice => slice.items.some(item => !!item && ItemSpec.equals(item, spec)));

	return (
		<Button
			iconOnly
			aria-label={i18n.t('upgrades_tab.results.batch', { ns: 'upgrades' })}
			aria-pressed={inBatch}
			title={i18n.t(inBatch ? 'upgrades_tab.toggles.batch_remove' : 'upgrades_tab.toggles.batch_add', { ns: 'upgrades' })}
			className={clsx('w-8', inBatch && 'text-brand')}
			data-testid="upgrades-batch-toggle"
			onClick={() => (inBatch ? removeBulkItem : addBulkItem)(player, spec)}>
			<Icon name="arrow-right-arrow-left" size="xl" />
		</Button>
	);
};
