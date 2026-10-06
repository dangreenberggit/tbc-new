import i18n from '@i18n/config';

import { type RunState, visibleRows } from '../../model/run_reducer';
import { formatDps, formatSeconds } from '../../utils/format';

export interface StatusLineProps {
	run: RunState;
}

/** One line on the run: rows landed so far, or the baseline a finished or stopped run measured. */
export const StatusLine = ({ run }: StatusLineProps) => {
	switch (run.status) {
		case 'running':
			return (
				<p className="mb-0" data-testid="upgrades-status-line">
					{i18n.t('upgrades_tab.status.running', { count: run.landedRows.length })}
				</p>
			);
		case 'done':
			return (
				<p className="mb-0" data-testid="upgrades-baseline-summary">
					{i18n.t('upgrades_tab.status.done', { dps: formatDps(run.result.baseline.dps) })}{' '}
					{i18n.t('upgrades_tab.status.took', { seconds: formatSeconds(run.result.durationMs) })}
				</p>
			);
		case 'stopped': {
			// No time on a stopped run: it would read as the cost of a full ranking (ticket 460).
			const dps = formatDps(run.result.baseline.dps);
			return (
				<p className="mb-0 text-warning" data-testid="upgrades-baseline-summary">
					{visibleRows(run).length > 0 ? i18n.t('upgrades_tab.status.stopped_partial', { dps }) : i18n.t('upgrades_tab.status.stopped', { dps })}
				</p>
			);
		}
		default:
			return null;
	}
};
