import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Button } from '@ui-kit/Button';
import { Chip } from '@ui-kit/Chip';
import { FieldLabel } from '@ui-kit/FormControl';
import { Tooltip } from '@ui-kit/Tooltip';
import { useId, useState } from 'react';

import type { GearSetOption } from '../../model/settings_pool';

export interface GearSetChipsProps {
	chips: { thisPhase: readonly GearSetOption[]; otherPhases: readonly GearSetOption[] };
	selectedKeys: readonly string[];
	prune: boolean;
	onToggleGearSet: (key: string) => void;
	onPruneChange: (prune: boolean) => void;
}

interface ChipRowProps {
	options: readonly GearSetOption[];
	selectedKeys: readonly string[];
	tooltipId: string;
	onToggleGearSet: (key: string) => void;
}

/** A gear set with nothing in this phase's pool stays visible and muted, so its "0/m in pool" reason can be read. */
const ChipRow = ({ options, selectedKeys, tooltipId, onToggleGearSet }: ChipRowProps) => (
	<div className="flex flex-wrap gap-2">
		{options.map(option => {
			const unavailable = option.inPoolCount === 0;
			const selected = selectedKeys.includes(option.key);
			return (
				<Chip
					key={option.key}
					testId="upgrades-gear-set-chip"
					label={option.label}
					active={selected}
					disabled={unavailable}
					onSelect={unavailable ? undefined : () => onToggleGearSet(option.key)}
					chipTooltipId={tooltipId}
					tooltip={i18n.t('upgrades_tab.settings.gear_set_in_pool', { ns: 'upgrades', n: option.inPoolCount, m: option.itemIds.length })}
					rootProps={{ 'data-gear-set-key': option.key }}
					nameProps={{ 'aria-pressed': selected, 'aria-disabled': unavailable || undefined }}
				/>
			);
		})}
	</div>
);

/** The gear sets a run can be limited to: this phase's chips, the other phases' behind a disclosure, and the prune toggle. */
export const GearSetChips = ({ chips, selectedKeys, prune, onToggleGearSet, onPruneChange }: GearSetChipsProps) => {
	const [otherOpen, setOtherOpen] = useState(false);
	const titleId = useId();
	const otherId = useId();
	const tooltipId = useId();
	const pruneId = useId();
	return (
		<div className="grid justify-items-start gap-2" role="group" aria-labelledby={titleId}>
			<FieldLabel as="span" id={titleId}>
				{i18n.t('upgrades_tab.settings.sets_title', { ns: 'upgrades' })}
			</FieldLabel>
			<ChipRow options={chips.thisPhase} selectedKeys={selectedKeys} tooltipId={tooltipId} onToggleGearSet={onToggleGearSet} />
			{chips.otherPhases.length > 0 && (
				<>
					<Button
						variant="link"
						size="inline"
						data-testid="upgrades-sets-other"
						aria-expanded={otherOpen}
						aria-controls={otherId}
						onClick={() => setOtherOpen(open => !open)}>
						{i18n.t('upgrades_tab.settings.sets_other_phases', { ns: 'upgrades', n: chips.otherPhases.length })}
					</Button>
					<div id={otherId} hidden={!otherOpen}>
						<ChipRow options={chips.otherPhases} selectedKeys={selectedKeys} tooltipId={tooltipId} onToggleGearSet={onToggleGearSet} />
					</div>
				</>
			)}
			{selectedKeys.length > 0 && (
				<div data-testid="upgrades-prune">
					<BooleanPicker
						modObject={null}
						config={{
							id: pruneId,
							label: i18n.t('upgrades_tab.prune.only_bis', { ns: 'upgrades' }),
							layout: 'inline',
							value: prune,
							onChange: onPruneChange,
						}}
					/>
				</div>
			)}
			<Tooltip id={tooltipId} place="bottom" />
		</div>
	);
};
