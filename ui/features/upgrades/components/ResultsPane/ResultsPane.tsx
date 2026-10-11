import i18n from '@i18n/config';

import { useResultsTable } from '../../hooks/useResultsTable';
import type { RankedItem } from '../../model/engine/rank';
import { BelowCutoffGroup } from '../BelowCutoffGroup';
import { EmptyState } from '../EmptyState';
import { ResultRows, ResultsTable, type RowContext, ScreenReaderResultsHead, SortableResultsHead } from '../ResultsTable';

export interface ResultsPaneProps {
	/** The main table's rows (`paneRows`): the shortlist, plus the BiS-list rows that miss the cutoff. */
	main: readonly RankedItem[];
	/** The keys (`rowKey`) of the main table's rows that miss the cutoff, each marked as not an upgrade. */
	notUpgrades?: ReadonlySet<string>;
	belowCutoff: readonly RankedItem[];
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
export const ResultsPane = ({ main, notUpgrades, belowCutoff, rowContext, groupOpen, onGroupOpenChange }: ResultsPaneProps) => {
	const mainTable = useResultsTable(main, rowContext);
	const groupTable = useResultsTable(belowCutoff, rowContext);
	return (
		<>
			{main.length > 0 ? (
				<ResultsTable>
					<SortableResultsHead table={mainTable} />
					<ResultRows table={mainTable} rowContext={rowContext} notUpgrades={notUpgrades} />
				</ResultsTable>
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
