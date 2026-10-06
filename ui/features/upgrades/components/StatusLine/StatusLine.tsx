import i18n from '@i18n/config';

import { type RunState, visibleRows } from '../../model/run_reducer';
import { formatDps, formatSeconds } from '../../utils/format';

export interface StatusLineProps {
	run: RunState;
}

/** Where the run is: what the tab does before a run, the rows landed so far, or the baseline it measured. */
const RunStatusText = ({ run }: StatusLineProps) => {
	switch (run.status) {
		case 'idle':
			return i18n.t('upgrades_tab.status.idle');
		case 'running':
			return (
				<span data-testid="upgrades-status-line">
					{run.stopping ? i18n.t('upgrades_tab.status.stopping') : i18n.t('upgrades_tab.status.running', { count: run.landedRows.length })}
				</span>
			);
		case 'done':
			return (
				<span data-testid="upgrades-baseline-summary">
					{run.result.durationMs === undefined
						? i18n.t('upgrades_tab.status.done', { dps: formatDps(run.result.baseline.dps) })
						: i18n.t('upgrades_tab.status.done_took', { dps: formatDps(run.result.baseline.dps), seconds: formatSeconds(run.result.durationMs) })}
				</span>
			);
		case 'stopped': {
			// No time on a stopped run: it would read as the cost of a full ranking (ticket 460).
			const dps = formatDps(run.result.baseline.dps);
			return (
				<span className="text-warning" data-testid="upgrades-baseline-summary">
					{visibleRows(run).length > 0 ? i18n.t('upgrades_tab.status.stopped_partial', { dps }) : i18n.t('upgrades_tab.status.stopped', { dps })}
				</span>
			);
		}
		case 'error':
			return null;
	}
};

/**
 * The run's status in two live regions, both always in the page so that a
 * screen reader hears each change (old tab): the polite region carries every
 * state but a failure, and the alert region carries only the failure.
 */
export const StatusLine = ({ run }: StatusLineProps) => (
	<div data-testid="upgrades-status">
		<p className="mb-0" role="status" aria-live="polite" aria-atomic="true" data-testid="upgrades-status-polite">
			<RunStatusText run={run} />
		</p>
		<p className="mb-0 text-danger" role="alert" data-testid="upgrades-status-alert">
			{run.status === 'error' ? run.message : null}
		</p>
	</div>
);

/** Says that the result on screen was measured on other inputs than the page and the settings hold now. */
export const StaleNotice = () => (
	<p className="mb-0 text-warning" data-testid="upgrades-stale">
		<strong>{i18n.t('upgrades_tab.status.stale')}</strong> {i18n.t('upgrades_tab.status.stale_hint')}
	</p>
);
