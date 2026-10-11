import i18n from '@i18n/config';
import { Accordion, AccordionItem } from '@ui-kit/Accordion';
import type { ReactNode } from 'react';

import type { ResultsTableModel } from '../../hooks/useResultsTable';
import { ResultRows, ResultsTable, type RowContext } from '../ResultsTable';

export interface BelowCutoffGroupProps {
	/** The table's head: the caller knows whether another head above already names the columns on screen. */
	head: ReactNode;
	/** The group's table (`useResultsTable` over the rows below the cutoff); the caller builds it, because the head reads it too. */
	table: ResultsTableModel;
	rowContext: RowContext;
	/** Whether the group is open. The caller keeps it, because its pane is unmounted while another pane is shown. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const GROUP = 'below-cutoff';

/**
 * The rows the cutoff left out, behind one expand ("hidden, never deleted",
 * candidate-pool.md §6.1). Collapsed until opened, and its table is not
 * mounted until then. The shared sort orders it too, so the order does not
 * stop at the fold (ticket 280). Its title names the bar in DPS from the
 * ranking the rows came from, so a recorded fixture names the bar its rows
 * were judged against (ADR-0037).
 */
export const BelowCutoffGroup = ({ head, table, rowContext, open, onOpenChange }: BelowCutoffGroupProps) => {
	const count = table.options.data.length;
	const cutoff = rowContext.tip.ranking?.cutoff;
	const title =
		cutoff === undefined
			? i18n.t('upgrades_tab.results.below_cutoff_group', { ns: 'upgrades', count })
			: i18n.t('upgrades_tab.results.below_cutoff_group_bar', { ns: 'upgrades', count, abs: String(cutoff.absDps) });

	return (
		<Accordion value={open ? [GROUP] : []} onValueChange={value => onOpenChange(value.includes(GROUP))}>
			<AccordionItem value={GROUP} testId="upgrades-below-cutoff" title={title}>
				<ResultsTable>
					{head}
					<ResultRows table={table} rowContext={rowContext} />
				</ResultsTable>
			</AccordionItem>
		</Accordion>
	);
};
