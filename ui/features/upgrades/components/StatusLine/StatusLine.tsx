import i18n from '@i18n/config';

import { type RunState, visibleRows } from '../../model/run_reducer';
import { formatDps, formatSeconds } from '../../utils/format';

export interface StatusLineProps {
	run: RunState;
	/** The result on screen was measured on other inputs than the page and settings hold now. */
	stale?: boolean;
}

const StaleLine = () => (
	<p className="mb-0 text-warning" data-testid="upgrades-stale">
		<strong>{i18n.t('upgrades_tab.status.stale')}</strong> {i18n.t('upgrades_tab.status.stale_hint')}
	</p>
);

/** One line on the run: rows landed so far, or the baseline a finished or stopped run measured. */
export const StatusLine = ({ run, stale = false }: StatusLineProps) => {
	switch (run.status) {
		case 'running':
			return (
				<p className="mb-0" data-testid="upgrades-status-line">
					{run.stopping ? i18n.t('upgrades_tab.status.stopping') : i18n.t('upgrades_tab.status.running', { count: run.landedRows.length })}
				</p>
			);
		case 'done':
			return (
				<>
					{stale && <StaleLine />}
					<p className="mb-0" data-testid="upgrades-baseline-summary">
						{run.result.durationMs === undefined
							? i18n.t('upgrades_tab.status.done', { dps: formatDps(run.result.baseline.dps) })
							: i18n.t('upgrades_tab.status.done_took', {
									dps: formatDps(run.result.baseline.dps),
									seconds: formatSeconds(run.result.durationMs),
								})}
					</p>
				</>
			);
		case 'stopped': {
			// No time on a stopped run: it would read as the cost of a full ranking (ticket 460).
			const dps = formatDps(run.result.baseline.dps);
			return (
				<>
					{stale && <StaleLine />}
					<p className="mb-0 text-warning" data-testid="upgrades-baseline-summary">
						{visibleRows(run).length > 0 ? i18n.t('upgrades_tab.status.stopped_partial', { dps }) : i18n.t('upgrades_tab.status.stopped', { dps })}
					</p>
				</>
			);
		}
		default:
			return null;
	}
};
