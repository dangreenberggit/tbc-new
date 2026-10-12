import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { useId, useState } from 'react';

import { type ViewSourceOptions, withOfferedSourcesHidden } from '../../model/results_view';
import { ViewSourcesDialog } from './ViewSourcesDialog';

export interface ViewSourcesButtonProps {
	/** The sources the settled table offers (`viewSourceOptions`). */
	options: ViewSourceOptions;
	/** The hidden sources as stored, which may name a source this table does not offer. */
	hidden: readonly string[];
	onToggle: (key: string) => void;
	/** Sets the whole hidden list: Show all and Hide all. */
	onSetAll: (keys: readonly string[]) => void;
}

/**
 * The "Filter by source" button, a one-line count of the sources it hides,
 * and the dialog it opens. The count reads only the sources this table
 * offers, so a source hidden in an earlier run that this one does not offer
 * is not counted (it hides nothing here).
 */
export const ViewSourcesButton = ({ options, hidden, onToggle, onSetAll }: ViewSourcesButtonProps) => {
	const [open, setOpen] = useState(false);
	const summaryId = useId();
	const offered = [...options.raids, ...options.other].map(option => option.key);
	const hiddenCount = offered.filter(key => hidden.includes(key)).length;
	return (
		<div className="grid justify-items-start gap-1">
			<Button variant="secondary" data-testid="upgrades-view-sources-button" aria-describedby={summaryId} onClick={() => setOpen(true)}>
				{i18n.t('upgrades_tab.view.filter_by_source', { ns: 'upgrades' })}
			</Button>
			<p className="mb-0 text-sm text-muted" id={summaryId} data-testid="upgrades-view-sources-summary">
				{hiddenCount === 0
					? i18n.t('upgrades_tab.view.sources_summary_none', { ns: 'upgrades' })
					: i18n.t('upgrades_tab.view.sources_summary', { ns: 'upgrades', n: hiddenCount, m: offered.length })}
			</p>
			<ViewSourcesDialog
				open={open}
				onOpenChange={setOpen}
				options={options}
				hidden={hidden}
				onToggle={onToggle}
				onShowAll={() => onSetAll([])}
				onHideAll={() => onSetAll(withOfferedSourcesHidden(hidden, offered))}
			/>
		</div>
	);
};
