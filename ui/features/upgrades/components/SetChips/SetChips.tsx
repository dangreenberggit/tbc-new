import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Button } from '@ui-kit/Button';
import { Chip } from '@ui-kit/Chip';
import { FieldLabel } from '@ui-kit/FormControl';
import { Tooltip } from '@ui-kit/Tooltip';
import { useId, useState } from 'react';

import type { SetOption } from '../../model/settings_pool';

export interface SetChipsProps {
	chips: { main: readonly SetOption[]; other: readonly SetOption[] };
	selectedKeys: readonly string[];
	prune: boolean;
	onToggleSet: (key: string) => void;
	onPruneChange: (prune: boolean) => void;
}

interface ChipRowProps {
	options: readonly SetOption[];
	selectedKeys: readonly string[];
	tooltipId: string;
	onToggleSet: (key: string) => void;
}

/** A set with nothing in this phase's pool stays visible and muted, so its "0/m in pool" reason can be read. */
const ChipRow = ({ options, selectedKeys, tooltipId, onToggleSet }: ChipRowProps) => (
	<div className="flex flex-wrap gap-2">
		{options.map(option => {
			const unavailable = option.inPool === 0;
			const selected = selectedKeys.includes(option.key);
			return (
				<Chip
					key={option.key}
					testId="upgrades-set-chip"
					label={option.label}
					active={selected}
					disabled={unavailable}
					onSelect={unavailable ? undefined : () => onToggleSet(option.key)}
					chipTooltipId={tooltipId}
					tooltip={i18n.t('upgrades_tab.settings.sets_in_pool', { n: option.inPool, m: option.itemIds.length })}
					rootProps={{ 'data-set-key': option.key }}
					nameProps={{ 'aria-pressed': selected, 'aria-disabled': unavailable || undefined }}
				/>
			);
		})}
	</div>
);

/** The gear sets a run can be limited to: this phase's chips, the other phases' behind a disclosure, and the prune. */
export const SetChips = ({ chips, selectedKeys, prune, onToggleSet, onPruneChange }: SetChipsProps) => {
	const [otherOpen, setOtherOpen] = useState(false);
	const titleId = useId();
	const otherId = useId();
	const tooltipId = useId();
	const pruneId = useId();
	return (
		<div className="grid justify-items-start gap-2" role="group" aria-labelledby={titleId}>
			<FieldLabel as="span" id={titleId}>
				{i18n.t('upgrades_tab.settings.sets_title')}
			</FieldLabel>
			<ChipRow options={chips.main} selectedKeys={selectedKeys} tooltipId={tooltipId} onToggleSet={onToggleSet} />
			{chips.other.length > 0 && (
				<>
					<Button
						variant="link"
						size="inline"
						data-testid="upgrades-sets-other"
						aria-expanded={otherOpen}
						aria-controls={otherId}
						onClick={() => setOtherOpen(open => !open)}>
						{i18n.t('upgrades_tab.settings.sets_other_phases', { n: chips.other.length })}
					</Button>
					<div id={otherId} hidden={!otherOpen}>
						<ChipRow options={chips.other} selectedKeys={selectedKeys} tooltipId={tooltipId} onToggleSet={onToggleSet} />
					</div>
				</>
			)}
			{selectedKeys.length > 0 && (
				<div data-testid="upgrades-prune">
					<BooleanPicker
						modObject={null}
						config={{ id: pruneId, label: i18n.t('upgrades_tab.prune.only_bis'), layout: 'inline', value: prune, onChange: onPruneChange }}
					/>
				</div>
			)}
			<Tooltip id={tooltipId} place="bottom" />
		</div>
	);
};
