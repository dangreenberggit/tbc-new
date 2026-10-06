import { Tabs } from '@base-ui/react/tabs';
import i18n from '@i18n/config';
import { TabNav, type TabNavTab, TabPanel, TabPanels } from '@ui-kit/TabNav';
import { useState } from 'react';

import type { ViewResult } from '../../model/engine/view';
import { nextSort, type ResultsSort, type ResultsSortKey } from '../../model/results_sort';
import { effectiveSlot, paneRows, type ResultsTabId, SHOPPING_LIST_TAB, slotTabs } from '../../model/results_view';
import { slotLabel } from '../../utils/format';
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
 * with a row. The open tab and the one column sort shared by every pane
 * (ticket 280) live here; neither is stored.
 */
type Pane = { id: ResultsTabId; label: string; badge?: string; className?: string };

export const ResultsPanes = ({ view, rowContext }: ResultsPanesProps) => {
	// A string, because the tab strip reports any tab's value; `shownTab` checks it against this view's panes.
	const [activeTab, setActiveTab] = useState<string>(SHOPPING_LIST_TAB);
	const [sort, setSort] = useState<ResultsSort>();
	const onSort = (key: ResultsSortKey) => setSort(current => nextSort(current, key));

	const panes: Pane[] = [
		{ id: SHOPPING_LIST_TAB, label: i18n.t('upgrades_tab.subtabs.shopping_list') },
		...slotTabs(view).map(slot => {
			// Every slot tab comes from a row of the view, so this finds one.
			const row = view.rows.find(candidate => effectiveSlot(candidate) === slot.id);
			return {
				id: slot.id,
				label: row ? slotLabel(row) : slot.id,
				badge: String(slot.count),
				// A slot with nothing above the cutoff keeps its tab, dimmed, so the user can open it and see why.
				className: slot.count === 0 ? 'opacity-60' : undefined,
			};
		}),
	];
	// A new result without the open slot falls back to the Upgrades list, as the old tab did.
	const shownTab = panes.find(pane => pane.id === activeTab)?.id ?? SHOPPING_LIST_TAB;
	const tabs: TabNavTab[] = panes.map(pane => ({ ...pane, ariaControls: paneId(pane.id) }));

	return (
		<Tabs.Root value={shownTab} onValueChange={next => setActiveTab(String(next))}>
			<TabNav tabs={tabs} testId="upgrades-tab-tabs" />
			<TabPanels>
				{panes.map(pane => {
					const { shortlist, belowCutoff } = paneRows(view, pane.id);
					return (
						<TabPanel key={pane.id} value={pane.id} id={paneId(pane.id)}>
							<ResultsPane shortlist={shortlist} belowCutoff={belowCutoff} rowContext={rowContext} sort={sort} onSort={onSort} />
						</TabPanel>
					);
				})}
			</TabPanels>
		</Tabs.Root>
	);
};
