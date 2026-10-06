import i18n from '@i18n/config';
import { Accordion, AccordionItem } from '@ui-kit/Accordion';
import { useState } from 'react';

import type { RankedItem } from '../../model/engine/rank';
import type { ResultsSort } from '../../model/results_sort';
import { ResultRows, ResultsTable, type RowContext } from '../ResultsTable';

export interface BelowCutoffGroupProps {
	rows: readonly RankedItem[];
	rowContext: RowContext;
	sort?: ResultsSort;
}

const GROUP = 'below-cutoff';

/**
 * The rows the cutoff left out, behind one expand ("hidden, never deleted",
 * candidate-pool.md §6.1). Collapsed until opened, and its table is not
 * mounted until then. The shared sort orders it too, so the order does not
 * stop at the fold (ticket 280).
 */
export const BelowCutoffGroup = ({ rows, rowContext, sort }: BelowCutoffGroupProps) => {
	const [open, setOpen] = useState<string[]>([]);

	return (
		<Accordion value={open} onValueChange={setOpen}>
			<AccordionItem value={GROUP} testId="upgrades-below-cutoff" title={i18n.t('upgrades_tab.results.below_cutoff_group', { count: rows.length })}>
				<ResultsTable>
					<ResultRows rows={rows} rowContext={rowContext} sort={sort} />
				</ResultsTable>
			</AccordionItem>
		</Accordion>
	);
};
