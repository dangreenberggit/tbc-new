import { bulkIterationsLimit } from '@features/bulk/model/limits';
import i18n from '@i18n/config';
import { useSim } from '@sim/context/SimHostContext';
import { formatToNumber } from '@sim/utils/format';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import { NumberPicker } from '@ui-kit/NumberPicker';
import { Tooltip, tooltipAnchorProps } from '@ui-kit/Tooltip';
import { useId } from 'react';
import { useStore } from 'zustand';

import { numberSettingSource } from '../../hooks/useUpgradesStore';
import type { UpgradesStore } from '../../model/upgrades_store';

const ITERATIONS = numberSettingSource('iterations');

export interface RunControlsProps {
	ready: boolean;
	running: boolean;
	store: UpgradesStore;
	/** The eligible candidate count the panel shows; undefined while it is unknown. */
	candidates: number | undefined;
	onIterationsChange: (iterations: number) => void;
	onStart: () => void;
}

/**
 * The Bulk tab's iterations warning (`features/bulk/components/BulkSettings/CombinationsCount.tsx`), with its limit
 * for this host and its words. The Bulk tab weighs the batch's iterations in all; here that is at least one sim for
 * the baseline and one per candidate the run takes, so the warning's "over" is true whenever it shows. Like the Bulk
 * tab, it never blocks a run.
 */
const IterationsWarning = ({ store, candidates }: { store: UpgradesStore; candidates: number | undefined }) => {
	const sim = useSim();
	const tooltipId = useId();
	const iterations = useStore(store, state => state.settings.iterations);
	const cap = useStore(store, state => state.settings.candidateCap);
	const limit = bulkIterationsLimit(sim.isNative);
	if (candidates === undefined) return null;
	const sims = 1 + Math.min(candidates, cap ?? candidates);
	if (!(sims * iterations > limit)) return null;
	const warningText = i18n.t('bulk_tab.warning.iterations_limit', { limit: formatToNumber(limit) });
	return (
		<div>
			<button
				type="button"
				aria-label={warningText}
				className="text-link-warning"
				data-testid="upgrades-iterations-warning"
				{...tooltipAnchorProps(tooltipId)}>
				<Icon name="exclamation-triangle" size="2x" />
			</button>
			<Tooltip id={tooltipId} place="right" content={warningText} />
		</div>
	);
};

/** The iterations field and Run. Stop is the progress dialog's cancel, as on the Bulk tab. */
export const RunControls = ({ ready, running, store, candidates, onIterationsChange, onStart }: RunControlsProps) => (
	<div className="grid gap-6" data-testid="upgrades-run-controls">
		<NumberPicker
			modObject={store}
			testId="upgrades-iterations-picker"
			config={{
				id: 'upgrades-iterations',
				label: i18n.t('upgrades_tab.iterations_label', { ns: 'upgrades' }),
				positive: true,
				...ITERATIONS,
				setValue: (_store, next) => onIterationsChange(next),
			}}
		/>
		<IterationsWarning store={store} candidates={candidates} />
		<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={onStart}>
			{i18n.t('upgrades_tab.run', { ns: 'upgrades' })}
		</Button>
	</div>
);
