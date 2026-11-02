import i18n from '@i18n/config';

import { useResultsTable } from '../../hooks/useResultsTable';
import type { PaneEmptyReason, PaneRows } from '../../model/results_view';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultRows, ResultsTable, type RowContext, ScreenReaderResultsHead, SortableResultsHead } from '../ResultsTable';

const EMPTY_BODY_KEYS = {
	'no-source-row': 'upgrades_tab.results.empty_no_source_row',
} as const satisfies Record<Exclude<PaneEmptyReason, 'no-upgrades'>, string>;

export interface ResultsPaneProps {
	/** The pane's rows as `paneRows` splits them; with no main table and no below-cutoff group, `emptyReason` picks the empty state's text. */
	rows: PaneRows;
	rowContext: RowContext;
	/** Whether the below-cutoff group is open; `ResultsPanes` keeps it per pane, so it survives a switch to another pane. */
	groupOpen: boolean;
	onGroupOpenChange: (open: boolean) => void;
}

/**
 * One sub-tab's results: its main table, then the rows below the cutoff behind
 * an expand. Under a main table the group's head is for screen readers only,
 * because the main table's head names the columns on screen; with no main
 * table the group gets the sortable head. Both tables follow the tab store's
 * one sort, so a click on either head orders both.
 *
 * An empty-state message shows only when the pane shows no row at all: beside
 * the group, "No items to show" or "No rows from the shown sources." would be
 * false (ticket 748). The group's own label says what its rows gained.
 */
export const ResultsPane = ({ rows, rowContext, groupOpen, onGroupOpenChange }: ResultsPaneProps) => {
	const { main, notUpgrades, belowCutoff, emptyReason } = rows;
	const mainTable = useResultsTable(main, rowContext);
	const groupTable = useResultsTable(belowCutoff, rowContext);
	return (
		<>
			{main.length > 0 ? (
				<ResultsTable>
					<SortableResultsHead table={mainTable} />
					<ResultRows table={mainTable} rowContext={rowContext} notUpgrades={notUpgrades} />
				</ResultsTable>
			) : belowCutoff.length > 0 ? null : emptyReason === 'no-upgrades' ? (
				<EmptyState
					title={i18n.t('upgrades_tab.results.empty_no_upgrades', { ns: 'upgrades' })}
					body={i18n.t('upgrades_tab.results.empty_no_upgrades_body', { ns: 'upgrades' })}
				/>
			) : (
				<EmptyState body={i18n.t(EMPTY_BODY_KEYS[emptyReason], { ns: 'upgrades' })} />
			)}
			{belowCutoff.length > 0 && (
				<BelowCutoffGroup
					head={main.length > 0 ? <ScreenReaderResultsHead table={groupTable} /> : <SortableResultsHead table={groupTable} />}
					table={groupTable}
					rowContext={rowContext}
					open={groupOpen}
					onOpenChange={onGroupOpenChange}
				/>
			)}
		</>
	);
};
