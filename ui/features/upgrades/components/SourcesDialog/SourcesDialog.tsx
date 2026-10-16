import i18n from '@i18n/config';
import { Dialog } from '@ui-kit/Dialog';

import type { SourceOption } from '../../model/settings_pool';
import { SourceSection } from '../SourceSection';

export interface SourcesDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sources: { raids: readonly SourceOption[]; other: readonly SourceOption[] };
	excluded: readonly string[];
	onToggle: (key: string) => void;
}

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
			unticked={excluded}
			onToggle={onToggle}
			rowTestId="upgrades-source-row"
		/>
		<SourceSection
			title={i18n.t('upgrades_tab.settings.sources_section_other', { ns: 'upgrades' })}
			options={sources.other}
			unticked={excluded}
			onToggle={onToggle}
			rowTestId="upgrades-source-row"
		/>
	</Dialog>
);
