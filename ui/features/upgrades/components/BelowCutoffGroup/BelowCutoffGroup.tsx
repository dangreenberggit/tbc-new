import i18n from '@i18n/config';
import { Accordion, AccordionItem } from '@ui-kit/Accordion';
import { type ReactNode, useState } from 'react';

import type { ResultsTableModel } from '../../hooks/useResultsTable';
import { ResultRows, ResultsTable, type RowContext } from '../ResultsTable';

export interface BelowCutoffGroupProps {
	/** The table's head: the caller knows whether another head above already names the columns on screen. */
	head: ReactNode;
	/** The group's table (`useResultsTable` over the rows below the cutoff); the caller builds it, because the head reads it too. */
	table: ResultsTableModel;
	rowContext: RowContext;
}

const GROUP = 'below-cutoff';

/**
 * The rows the cutoff left out, behind one expand ("hidden, never deleted",
 * candidate-pool.md §6.1). Collapsed until opened, and its table is not
 * mounted until then. The shared sort orders it too, so the order does not
 * stop at the fold (ticket 280).
 */
export const BelowCutoffGroup = ({ head, table, rowContext }: BelowCutoffGroupProps) => {
	const [open, setOpen] = useState<string[]>([]);

	return (
		<Accordion value={open} onValueChange={setOpen}>
			<AccordionItem
				value={GROUP}
				testId="upgrades-below-cutoff"
				title={i18n.t('upgrades_tab.results.below_cutoff_group', { ns: 'upgrades', count: table.options.data.length })}>
				<ResultsTable>
					{head}
					<ResultRows table={table} rowContext={rowContext} />
				</ResultsTable>
			</AccordionItem>
		</Accordion>
	);
};
