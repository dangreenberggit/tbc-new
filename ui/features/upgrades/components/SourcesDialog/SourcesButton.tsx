import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { FieldLabel } from '@ui-kit/FormControl';
import { useId, useState } from 'react';

import type { SourceOption } from '../../model/settings_pool';
import { SourcesDialog } from './SourcesDialog';

export interface SourcesButtonProps {
	sources: { raids: readonly SourceOption[]; other: readonly SourceOption[] };
	excluded: readonly string[];
	onToggle: (key: string) => void;
}

/** The Sources button, a one-line count of what is excluded, and the dialog it opens. */
export const SourcesButton = ({ sources, excluded, onToggle }: SourcesButtonProps) => {
	const [open, setOpen] = useState(false);
	const titleId = useId();
	const total = sources.raids.length + sources.other.length;
	return (
		<div className="grid justify-items-start gap-1" role="group" aria-labelledby={titleId}>
			<FieldLabel as="span" id={titleId}>
				{i18n.t('upgrades_tab.settings.sources_title', { ns: 'upgrades' })}
			</FieldLabel>
			<Button variant="secondary" data-testid="upgrades-sources-button" disabled={total === 0} onClick={() => setOpen(true)}>
				{i18n.t('upgrades_tab.settings.sources_button', { ns: 'upgrades' })}
			</Button>
			<p className="mb-0 text-sm text-muted" data-testid="upgrades-sources-summary">
				{excluded.length === 0
					? i18n.t('upgrades_tab.settings.sources_summary_none', { ns: 'upgrades', m: total })
					: i18n.t('upgrades_tab.settings.sources_summary', { ns: 'upgrades', n: excluded.length, m: total })}
			</p>
			<SourcesDialog open={open} onOpenChange={setOpen} sources={sources} excluded={excluded} onToggle={onToggle} />
		</div>
	);
};
