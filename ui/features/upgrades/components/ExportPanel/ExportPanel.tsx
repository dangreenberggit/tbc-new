import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { ContentBlock } from '@ui-kit/ContentBlock';
import { CopyButton } from '@ui-kit/CopyButton';
import { TextArea } from '@ui-kit/FormControl';
import { useId } from 'react';

import { useUpgradesStore } from '../../hooks/useUpgradesStore';
import type { RankedItem } from '../../model/engine/rank';
import { exportPayload } from '../../model/export';
import { selectExportFlavour } from '../../model/upgrades_store';

export interface ExportPanelProps {
	/** The Upgrades pane's shortlist in the order on screen, so the payload keeps the cross-slot ranked order. */
	rows: readonly RankedItem[];
}

/**
 * The shortlist as JSON for a loot-priority tool such as ThatsMyBis (tickets
 * 126, 314). The token or gear choice lives in the tab's store, which saves
 * it with the tab's settings (ticket 588). Hidden when there is nothing to export.
 */
export const ExportPanel = ({ rows }: ExportPanelProps) => {
	const flavour = useUpgradesStore(selectExportFlavour);
	const setExportFlavour = useUpgradesStore(state => state.setExportFlavour);
	const flavourId = useId();
	const payload = exportPayload(rows, flavour);
	if (payload.items.length === 0) return null;
	const json = JSON.stringify(payload, null, 2);

	return (
		<ContentBlock testId="upgrades-export" className="mt-4" config={{ header: { title: i18n.t('upgrades_tab.export.title', { ns: 'upgrades' }) } }}>
			<p className="mb-2">{i18n.t('upgrades_tab.export.caveat', { ns: 'upgrades' })}</p>
			<BooleanPicker
				modObject={null}
				config={{
					id: flavourId,
					label: i18n.t('upgrades_tab.export.flavour_toggle', { ns: 'upgrades' }),
					layout: 'inline',
					value: flavour === 'token',
					onChange: tokens => setExportFlavour(tokens ? 'token' : 'gear'),
				}}
			/>
			<p className="mb-2 text-muted">
				{i18n.t(flavour === 'token' ? 'upgrades_tab.export.flavour_tokens' : 'upgrades_tab.export.flavour_gear', { ns: 'upgrades' })}
			</p>
			<TextArea readOnly rows={6} aria-label={i18n.t('upgrades_tab.export.title', { ns: 'upgrades' })} data-testid="upgrades-export-area" value={json} />
			<div className="mt-2 flex items-center justify-between gap-2">
				<span data-testid="upgrades-export-count">{i18n.t('upgrades_tab.export.count', { ns: 'upgrades', count: payload.items.length })}</span>
				<CopyButton variant="secondary" getContent={() => json} text={i18n.t('upgrades_tab.export.copy', { ns: 'upgrades' })} />
			</div>
		</ContentBlock>
	);
};
