import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { useId } from 'react';

import type { SourceOption } from '../../model/settings_pool';
import { sourceKeyLabel } from '../../utils/format';

export interface SourceSectionProps {
	title: string;
	options: readonly SourceOption[];
	/** The sources whose box is not ticked: excluded from the run's pool, or hidden from the settled table. */
	unticked: readonly string[];
	onToggle: (key: string) => void;
	/** Each row's test id; the pre-run and the settled dialogs keep their own. */
	rowTestId: string;
}

/** One group of sources, in two columns as the gear picker's source filter lays them out; a ticked box is a source kept. */
export const SourceSection = ({ title, options, unticked, onToggle, rowTestId }: SourceSectionProps) => {
	const idPrefix = useId();
	if (options.length === 0) return null;
	return (
		<fieldset>
			<legend className="mb-2 text-base font-bold">{title}</legend>
			<div className="grid grid-cols-2 gap-x-(--modal-padding) gap-y-1">
				{options.map((option, index) => (
					<div key={option.key} data-testid={rowTestId} data-source={option.key}>
						<BooleanPicker
							modObject={null}
							config={{
								id: `${idPrefix}-${index}`,
								label: sourceKeyLabel(option.key),
								layout: 'inline',
								value: !unticked.includes(option.key),
								onChange: () => onToggle(option.key),
							}}
						/>
					</div>
				))}
			</div>
		</fieldset>
	);
};
