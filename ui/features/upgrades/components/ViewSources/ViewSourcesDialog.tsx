import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Button } from '@ui-kit/Button';
import { Dialog } from '@ui-kit/Dialog';
import { useId } from 'react';

import type { ViewSourceOptions } from '../../model/results_view';
import type { SourceOption } from '../../model/settings_pool';
import { sourceKeyLabel } from '../../utils/format';

export interface ViewSourcesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	options: ViewSourceOptions;
	hidden: readonly string[];
	onToggle: (key: string) => void;
	onShowAll: () => void;
	onHideAll: () => void;
}

interface SourceSectionProps {
	title: string;
	options: readonly SourceOption[];
	hidden: readonly string[];
	onToggle: (key: string) => void;
}

/** One group of sources in two columns, laid out as the pre-run Sources dialog lays out its groups; a ticked box is a source shown. */
const SourceSection = ({ title, options, hidden, onToggle }: SourceSectionProps) => {
	const idPrefix = useId();
	if (options.length === 0) return null;
	return (
		<fieldset>
			<legend className="mb-2 text-base font-bold">{title}</legend>
			<div className="grid grid-cols-2 gap-x-(--modal-padding) gap-y-1">
				{options.map((option, index) => (
					<div key={option.key} data-testid="upgrades-view-source-row" data-source={option.key}>
						<BooleanPicker
							modObject={null}
							config={{
								id: `${idPrefix}-${index}`,
								label: sourceKeyLabel(option.key),
								layout: 'inline',
								value: !hidden.includes(option.key),
								onChange: () => onToggle(option.key),
							}}
						/>
					</div>
				))}
			</div>
		</fieldset>
	);
};

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
			hidden={hidden}
			onToggle={onToggle}
		/>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_other', { ns: 'upgrades' })}
			options={options.other}
			hidden={hidden}
			onToggle={onToggle}
		/>
	</Dialog>
);
