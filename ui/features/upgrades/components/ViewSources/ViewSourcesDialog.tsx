import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { Dialog } from '@ui-kit/Dialog';

import type { ViewSourceOptions } from '../../model/results_view';
import { SourceSection } from '../SourceSection';

export interface ViewSourcesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	options: ViewSourceOptions;
	hidden: readonly string[];
	onToggle: (key: string) => void;
	onShowAll: () => void;
	onHideAll: () => void;
}

/** Which sources a settled table shows: raids first, then the other sources, with Show all and Hide all. */
export const ViewSourcesDialog = ({ open, onOpenChange, options, hidden, onToggle, onShowAll, onHideAll }: ViewSourcesDialogProps) => (
	<Dialog
		open={open}
		onOpenChange={onOpenChange}
		testId="upgrades-view-sources-dialog"
		size="md"
		bodyGap="gap-3"
		title={i18n.t('upgrades_tab.view.filter_by_source', { ns: 'upgrades' })}
		footer={
			<div className="flex gap-2">
				<Button variant="secondary" data-testid="upgrades-view-sources-show-all" onClick={onShowAll}>
					{i18n.t('upgrades_tab.view.sources_show_all', { ns: 'upgrades' })}
				</Button>
				<Button variant="secondary" data-testid="upgrades-view-sources-hide-all" onClick={onHideAll}>
					{i18n.t('upgrades_tab.view.sources_hide_all', { ns: 'upgrades' })}
				</Button>
			</div>
		}>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_raids', { ns: 'upgrades' })}
			options={options.raids}
			unticked={hidden}
			onToggle={onToggle}
			rowTestId="upgrades-view-source-row"
		/>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_other', { ns: 'upgrades' })}
			options={options.other}
			unticked={hidden}
			onToggle={onToggle}
			rowTestId="upgrades-view-source-row"
		/>
	</Dialog>
);
