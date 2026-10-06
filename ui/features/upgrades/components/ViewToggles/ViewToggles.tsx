import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import type { ReactNode } from 'react';
import { useId } from 'react';

/**
 * The row of view toggles over a finished ranking, titled for what it does to
 * rows already measured, so it cannot be read as more run settings (old tab).
 * The caller composes the toggles it offers inside.
 */
export const ViewToggles = ({ children }: { children: ReactNode }) => (
	<fieldset className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="upgrades-view-toggles">
		<legend className="float-left mr-6 mb-0 text-sm font-bold">{i18n.t('upgrades_tab.view.title')}</legend>
		{children}
	</fieldset>
);

export interface ViewToggleProps {
	testId: string;
	label: string;
	tooltip: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}

/** One view toggle: a checkbox whose label carries the tooltip that says what it does. */
export const ViewToggle = ({ testId, label, tooltip, checked, onChange }: ViewToggleProps) => {
	const id = useId();
	return (
		<div data-testid={testId}>
			<BooleanPicker modObject={null} config={{ id, label, labelTooltip: tooltip, layout: 'inline', value: checked, onChange }} />
		</div>
	);
};
