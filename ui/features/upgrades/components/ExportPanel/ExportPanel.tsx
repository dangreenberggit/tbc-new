import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { ContentBlock } from '@ui-kit/ContentBlock';
import { CopyButton } from '@ui-kit/CopyButton';
import { TextArea } from '@ui-kit/FormControl';
import { useId } from 'react';

import { useUpgradesStore } from '../../hooks/useUpgradesStore';
import type { RankedItem } from '../../model/engine/rank';
import { exportPayload } from '../../model/export';
import { selectExportFlavor } from '../../model/upgrades_store';

export interface ExportPanelProps {
	/**
	 * The rows that meet the cutoff (`view.shortlist`) in the sort on screen, so the payload keeps the ranked
	 * order across slots. The Upgrades pane's main table also shows BiS-list rows that miss the cutoff;
	 * those are marked as not upgrades, so they stay out of the export.
	 */
	rows: readonly RankedItem[];
}

/**
 * The rows above the cutoff as JSON for a loot-priority tool such as ThatsMyBis. The token or gear
 * choice lives in the tab's store, which saves it with the tab's settings. Hidden when there is
 * nothing to export.
 */
export const ExportPanel = ({ rows }: ExportPanelProps) => {
	/** Whether a tier piece exports as itself or as its token. */
	const flavor = useUpgradesStore(selectExportFlavor);
	const setExportFlavor = useUpgradesStore(state => state.setExportFlavor);
	const flavorId = useId();
	const payload = exportPayload(rows, flavor);
	if (payload.items.length === 0) return null;
	const json = JSON.stringify(payload, null, 2);

	return (
		<ContentBlock testId="upgrades-export" className="mt-4" config={{ header: { title: i18n.t('upgrades_tab.export.title', { ns: 'upgrades' }) } }}>
			<p className="mb-2">{i18n.t('upgrades_tab.export.caveat', { ns: 'upgrades' })}</p>
			<BooleanPicker
				modObject={null}
				config={{
					id: flavorId,
					label: i18n.t('upgrades_tab.export.flavor_toggle', { ns: 'upgrades' }),
					layout: 'inline',
					value: flavor === 'token',
					onChange: useTokenIds => setExportFlavor(useTokenIds ? 'token' : 'gear'),
				}}
			/>
			<p className="mb-2 text-muted">
				{i18n.t(flavor === 'token' ? 'upgrades_tab.export.flavor_tokens' : 'upgrades_tab.export.flavor_gear', { ns: 'upgrades' })}
			</p>
			<TextArea readOnly rows={6} aria-label={i18n.t('upgrades_tab.export.title', { ns: 'upgrades' })} data-testid="upgrades-export-area" value={json} />
			<div className="mt-2 flex items-center justify-between gap-2">
				<span data-testid="upgrades-export-count">{i18n.t('upgrades_tab.export.count', { ns: 'upgrades', count: payload.items.length })}</span>
				<CopyButton variant="secondary" getContent={() => json} text={i18n.t('upgrades_tab.export.copy', { ns: 'upgrades' })} />
			</div>
		</ContentBlock>
	);
};
