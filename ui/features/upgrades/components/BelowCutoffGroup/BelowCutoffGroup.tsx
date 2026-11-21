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
 * The rows the cutoff left out, behind one button that expands them; the table is not mounted until
 * opened. The shared sort orders it too, so the order carries on past the fold. Its title reads the
 * cutoff from the rows' own ranking, so a recorded fixture names the cutoff its rows were judged by.
 */
export const BelowCutoffGroup = ({ head, table, rowContext, open, onOpenChange }: BelowCutoffGroupProps) => {
	const count = table.options.data.length;
	const cutoff = rowContext.rankingContext.ranking?.cutoff;
	// A key per count picked here, not i18next plurals, as upstream's bulk tab does (CombinationsCount.tsx).
	const title =
		cutoff === undefined
			? count === 1
				? i18n.t('upgrades_tab.results.below_cutoff_group_singular', { ns: 'upgrades' })
				: i18n.t('upgrades_tab.results.below_cutoff_group_count', { ns: 'upgrades', amount: count })
			: count === 1
				? i18n.t('upgrades_tab.results.below_cutoff_group_title_singular', { ns: 'upgrades', abs: String(cutoff.absDps) })
				: i18n.t('upgrades_tab.results.below_cutoff_group_title_count', { ns: 'upgrades', amount: count, abs: String(cutoff.absDps) });

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
