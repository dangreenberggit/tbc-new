import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Dialog } from '@ui-kit/Dialog';
import { useId } from 'react';

import type { SourceOption } from '../../model/settings_pool';
import { sourceKeyLabel } from '../../utils/format';

export interface SourcesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sources: { raids: readonly SourceOption[]; other: readonly SourceOption[] };
	excluded: readonly string[];
	onToggle: (key: string) => void;
}

interface SourceSectionProps {
	title: string;
	options: readonly SourceOption[];
	excluded: readonly string[];
	onToggle: (key: string) => void;
}

/** One group of sources, in two columns as the gear picker's source filter lays them out. */
const SourceSection = ({ title, options, excluded, onToggle }: SourceSectionProps) => {
	const idPrefix = useId();
	if (options.length === 0) return null;
	return (
		<fieldset>
			<legend className="mb-2 text-base font-bold">{title}</legend>
			<div className="grid grid-cols-2 gap-x-(--modal-padding) gap-y-1">
				{options.map((option, index) => (
					<div key={option.key} data-testid="upgrades-source-row" data-source={option.key}>
						<BooleanPicker
							modObject={null}
							config={{
								id: `${idPrefix}-${index}`,
								label: sourceKeyLabel(option.key),
								layout: 'inline',
								value: !excluded.includes(option.key),
								onChange: () => onToggle(option.key),
							}}
						/>
					</div>
				))}
			</div>
		</fieldset>
	);
};

/** Which item sources the run's pool keeps: raids first, then the other sources. */
export const SourcesDialog = ({ open, onOpenChange, sources, excluded, onToggle }: SourcesDialogProps) => (
	<Dialog
		open={open}
		onOpenChange={onOpenChange}
		testId="upgrades-sources-dialog"
		size="md"
		bodyGap="gap-3"
		title={i18n.t('upgrades_tab.settings.sources_title', { ns: 'upgrades' })}>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_raids', { ns: 'upgrades' })}
			options={sources.raids}
			excluded={excluded}
			onToggle={onToggle}
		/>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_other', { ns: 'upgrades' })}
			options={sources.other}
			excluded={excluded}
			onToggle={onToggle}
		/>
	</Dialog>
);
