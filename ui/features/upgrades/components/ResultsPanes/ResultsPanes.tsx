import { Tabs } from '@base-ui/react/tabs';
import i18n from '@i18n/config';
import { TabNav, type TabNavTab, TabPanel, TabPanels } from '@ui-kit/TabNav';
import { useMemo, useState } from 'react';

import { useResultsTable } from '../../hooks/useResultsTable';
import type { ViewResult } from '../../model/engine/view';
import { paneRows, type ResultsTabId, SHOPPING_LIST_TAB, slotTabs } from '../../model/results_view';
import { simSlotLabel } from '../../utils/format';
import { ExportPanel } from '../ExportPanel';
import { ResultsPane } from '../ResultsPane';
import type { RowContext } from '../ResultsTable';

export interface ResultsPanesProps {
	view: ViewResult;
	rowContext: RowContext;
}

/** `TabPanel` sets the pane's DOM id; the prefix keeps a slot name such as `head` from colliding with another id on the page. */
const paneId = (tab: ResultsTabId) => `upgrades-pane-${tab}`;

/**
 * A settled ranking as sub-tabs: the Upgrades list, then one pane per slot
 * with a row, then the export. The open tab lives here and is not stored; the
 * one column sort shared by every pane and the export (ticket 280) lives in the
 * tab store (ticket 565), which every results table reads.
 */
type Pane = { id: ResultsTabId; label: string; badge?: string; className?: string };

export const ResultsPanes = ({ view, rowContext }: ResultsPanesProps) => {
	// A string, because the tab strip reports any tab's value; `shownTab` checks it against this view's panes.
	const [activeTab, setActiveTab] = useState<string>(SHOPPING_LIST_TAB);
	const exportTable = useResultsTable(view.shortlist, rowContext);
	// Memoised on the view: `paneRows` filters new arrays on every call, and a new array rebuilds that pane's
	// tables, so without it every sort click would rebuild every pane's tables, not just re-sort them.
	const rowsByPane = useMemo(() => {
		const ids: ResultsTabId[] = [SHOPPING_LIST_TAB, ...slotTabs(view).map(slot => slot.id)];
		return new Map(ids.map(id => [id, paneRows(view, id)] as const));
	}, [view]);

	const panes: Pane[] = [
		{ id: SHOPPING_LIST_TAB, label: i18n.t('upgrades_tab.subtabs.shopping_list', { ns: 'upgrades' }) },
		...slotTabs(view).map(slot => ({
			id: slot.id,
			label: simSlotLabel(slot.id),
			badge: String(slot.count),
			// A slot with nothing above the cutoff keeps its tab, dimmed, so the user can open it and see why.
			className: slot.count === 0 ? 'opacity-60' : undefined,
		})),
	];
	// A new result without the open slot falls back to the Upgrades list, as the old tab did.
	const shownTab = panes.find(pane => pane.id === activeTab)?.id ?? SHOPPING_LIST_TAB;
	const tabs: TabNavTab[] = panes.map(pane => ({ ...pane, ariaControls: paneId(pane.id) }));

	return (
		<>
			<Tabs.Root value={shownTab} onValueChange={next => setActiveTab(String(next))}>
				<TabNav tabs={tabs} testId="upgrades-tab-tabs" />
				<TabPanels>
					{panes.map(pane => {
						const { shortlist, belowCutoff } = rowsByPane.get(pane.id) ?? paneRows(view, pane.id);
						return (
							<TabPanel key={pane.id} value={pane.id} id={paneId(pane.id)}>
								<ResultsPane shortlist={shortlist} belowCutoff={belowCutoff} rowContext={rowContext} />
							</TabPanel>
						);
					})}
				</TabPanels>
			</Tabs.Root>
			<ExportPanel rows={exportTable.getRowModel().rows.map(row => row.original)} />
		</>
	);
};
