import i18n from '@i18n/config';

import { useResultsTable } from '../../hooks/useResultsTable';
import type { PaneRows } from '../../model/results_view';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultRows, ResultsTable, type RowContext, ScreenReaderResultsHead, SortableResultsHead } from '../ResultsTable';

export interface ResultsPaneProps {
	/**
	 * The pane's rows as `paneRows` splits them. A slot pane under BiS only with no BiS-list row
	 * (`noBisListRow`), or a pane "Filter by source" emptied (`noSourceRow`), says so in its empty
	 * state instead of "No upgrades found".
	 */
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
 */
export const ResultsPane = ({ rows, rowContext, groupOpen, onGroupOpenChange }: ResultsPaneProps) => {
	const { main, notUpgrades, belowCutoff, noBisListRow, noSourceRow } = rows;
	const mainTable = useResultsTable(main, rowContext);
	const groupTable = useResultsTable(belowCutoff, rowContext);
	return (
		<>
			{main.length > 0 ? (
				<ResultsTable>
					<SortableResultsHead table={mainTable} />
					<ResultRows table={mainTable} rowContext={rowContext} notUpgrades={notUpgrades} />
				</ResultsTable>
			) : noSourceRow ? (
				<EmptyState body={i18n.t('upgrades_tab.results.empty_no_source_row', { ns: 'upgrades' })} />
			) : noBisListRow ? (
				<EmptyState body={i18n.t('upgrades_tab.results.empty_no_bis_row', { ns: 'upgrades' })} />
			) : (
				<EmptyState
					title={i18n.t('upgrades_tab.results.empty_no_upgrades', { ns: 'upgrades' })}
					body={i18n.t('upgrades_tab.results.empty_no_upgrades_body', { ns: 'upgrades' })}
				/>
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
