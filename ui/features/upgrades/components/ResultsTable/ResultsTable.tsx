import i18n from '@i18n/config';

import type { RankedItem } from '../../model/engine/rank';
import { ResultRow } from './ResultRow';

export interface ResultsTableProps {
	rows: readonly RankedItem[];
}

export const ResultsTable = ({ rows }: ResultsTableProps) => (
	<table className="w-full" data-testid="upgrades-results-table">
		<thead>
			<tr className="border-b border-b-border text-left">
				<th className="py-1 pr-3">{i18n.t('upgrades_tab.results.rank')}</th>
				<th className="py-1 pr-3">{i18n.t('upgrades_tab.results.item')}</th>
				<th className="py-1 pr-3">{i18n.t('upgrades_tab.results.slot')}</th>
				<th className="py-1 pr-3 text-right">{i18n.t('upgrades_tab.results.delta_dps')}</th>
				<th className="py-1">{i18n.t('upgrades_tab.results.source')}</th>
			</tr>
		</thead>
		<tbody>
			{rows.map((row, index) => (
				<ResultRow key={row.itemId} row={row} position={index + 1} />
			))}
		</tbody>
	</table>
);
