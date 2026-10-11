import { Tabs } from '@base-ui/react/tabs';
import i18n from '@i18n/config';
import { TabNav, type TabNavTab, TabPanel, TabPanels } from '@ui-kit/TabNav';
import { useMemo, useState } from 'react';

import { useResultsTable } from '../../hooks/useResultsTable';
import { paneRows, type ResultsTabId, type ResultsViewResult, SHOPPING_LIST_TAB, slotTabs } from '../../model/results_view';
import { simSlotLabel } from '../../utils/format';
import { ExportPanel } from '../ExportPanel';
import { ResultsPane } from '../ResultsPane';
import type { RowContext } from '../ResultsTable';

export interface ResultsPanesProps {
	view: ResultsViewResult;
	rowContext: RowContext;
}

/** `TabPanel` sets the pane's DOM id; the prefix keeps a slot name such as `head` from colliding with another id on the page. */
const paneId = (tab: ResultsTabId) => `upgrades-pane-${tab}`;

/**
 * A settled ranking as sub-tabs: the Upgrades list, then one pane per slot
 * with a row, then the export. The open tab lives here and is not stored; the
 * one column sort shared by every pane and the export (ticket 280) lives in the
 * tab store (ticket 565), which every results table reads.
 *
 * Only the shown pane is mounted (ticket 565): a hidden pane has no size, so
 * its rows could not be windowed. Which below-cutoff groups are open is kept
 * here for that reason, so a group stays open across a switch to another
 * pane, and only the shown pane's tab names a pane it controls.
 */
type Pane = { id: ResultsTabId; label: string; badge?: string; className?: string };
/** A pane's rows, and its slot for every pane but the Upgrades list. */
type PaneContent = { id: ResultsTabId; rows: ReturnType<typeof paneRows>; slot?: ReturnType<typeof slotTabs>[number] };

export const ResultsPanes = ({ view, rowContext }: ResultsPanesProps) => {
	// A string, because the tab strip reports any tab's value; `shownTab` checks it against this view's panes.
	const [activeTab, setActiveTab] = useState<string>(SHOPPING_LIST_TAB);
	const [openGroups, setOpenGroups] = useState<ReadonlySet<ResultsTabId>>(new Set());
	const [groupsSeenFor, setGroupsSeenFor] = useState(view);
	const setGroupOpen = (pane: ResultsTabId, open: boolean) =>
		setOpenGroups(current => {
			const next = new Set(current);
			if (open) next.add(pane);
			else next.delete(pane);
			return next;
		});
	const exportTable = useResultsTable(view.shortlist, rowContext);
	// Memoised on the view: `paneRows` filters new arrays on every call, and a new array rebuilds that pane's
	// tables, so without it every sort click would rebuild every pane's tables, not just re-sort them.
	const contents = useMemo(
		(): PaneContent[] => [
			{ id: SHOPPING_LIST_TAB, rows: paneRows(view, SHOPPING_LIST_TAB) },
			...slotTabs(view).map(slot => ({ id: slot.id, slot, rows: paneRows(view, slot.id) })),
		],
		[view],
	);
	// A group that a new view takes away closes, as it did when it lived in its own pane: it unmounted with
	// its rows. Adjusted during render, so no frame shows it open.
	if (groupsSeenFor !== view) {
		setGroupsSeenFor(view);
		const kept = [...openGroups].filter(id => contents.some(pane => pane.id === id && pane.rows.belowCutoff.length > 0));
		if (kept.length !== openGroups.size) setOpenGroups(new Set(kept));
	}

	const panes: Pane[] = contents.map(({ id, slot }) =>
		slot
			? {
					id,
					label: simSlotLabel(slot.id),
					badge: String(slot.count),
					// A slot with nothing above the cutoff keeps its tab, dimmed, so the user can open it and see why.
					className: slot.count === 0 ? 'opacity-60' : undefined,
				}
			: { id, label: i18n.t('upgrades_tab.subtabs.shopping_list', { ns: 'upgrades' }) },
	);
	// A new result without the open slot falls back to the Upgrades list, as the old tab did.
	const shownTab = panes.find(pane => pane.id === activeTab)?.id ?? SHOPPING_LIST_TAB;
	// `TabNav` falls back to the tab's own value when this is undefined, which is not a pane's id, so a tab whose pane is
	// not mounted gets an empty list instead.
	const tabs: TabNavTab[] = panes.map(pane => ({ ...pane, ariaControls: pane.id === shownTab ? paneId(pane.id) : '' }));

	return (
		<>
			<Tabs.Root value={shownTab} onValueChange={next => setActiveTab(String(next))}>
				<TabNav tabs={tabs} testId="upgrades-tab-tabs" />
				<TabPanels>
					{contents.map(({ id, rows }) => (
						<TabPanel key={id} value={id} id={paneId(id)} keepMounted={false}>
							<ResultsPane
								main={rows.main}
								notUpgrades={rows.notUpgrades}
								belowCutoff={rows.belowCutoff}
								rowContext={rowContext}
								groupOpen={openGroups.has(id)}
								onGroupOpenChange={open => setGroupOpen(id, open)}
							/>
						</TabPanel>
					))}
				</TabPanels>
			</Tabs.Root>
			<ExportPanel rows={exportTable.getRowModel().rows.map(row => row.original)} />
		</>
	);
};
