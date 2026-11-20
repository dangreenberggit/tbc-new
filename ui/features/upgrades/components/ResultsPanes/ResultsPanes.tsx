import { Tabs } from '@base-ui/react/tabs';
import i18n from '@i18n/config';
import { TabNav, type TabNavTab, TabPanel, TabPanels } from '@ui-kit/TabNav';
import { useMemo, useState } from 'react';

import { useResultsTable } from '../../hooks/useResultsTable';
import { ALL_SLOTS_PANE, type PaneId, type PaneRows, paneRows, type ResultsViewResult, slotTabs } from '../../model/results_view';
import { simSlotLabel } from '../../utils/format';
import { ExportPanel } from '../ExportPanel';
import { ResultsPane } from '../ResultsPane';
import type { RowContext } from '../ResultsTable';

export interface ResultsPanesProps {
	view: ResultsViewResult;
	rowContext: RowContext;
}

/** `TabPanel` sets the pane's DOM id; the prefix keeps a slot name such as `head` from colliding with another id on the page. */
const paneId = (tab: PaneId) => `upgrades-pane-${tab}`;

type SubTab = { id: PaneId; label: string; badge?: string; className?: string };
/** A pane's rows, and its slot for every pane but the Upgrades list. */
type PaneContent = { id: PaneId; rows: PaneRows; slot?: ReturnType<typeof slotTabs>[number] };

/**
 * A settled ranking as sub-tabs: the Upgrades list, one pane per slot `slotTabs` names, then the
 * export. The open tab lives here, unstored; the column sort every pane shares is in the tab store.
 * Only the shown pane is mounted, since a hidden pane has no size to virtualize its rows by, so
 * which below-cutoff groups are open is kept here, to survive a pane switch.
 */
export const ResultsPanes = ({ view, rowContext }: ResultsPanesProps) => {
	// A string, because the tab strip reports any tab's value; `shownTab` checks it against this view's panes.
	const [activeTab, setActiveTab] = useState<string>(ALL_SLOTS_PANE);
	const [openGroups, setOpenGroups] = useState<ReadonlySet<PaneId>>(new Set());
	const [groupsSeenFor, setGroupsSeenFor] = useState(view);
	const setGroupOpen = (pane: PaneId, open: boolean) =>
		setOpenGroups(current => {
			const next = new Set(current);
			if (open) next.add(pane);
			else next.delete(pane);
			return next;
		});
	const exportTable = useResultsTable(view.shortlist, rowContext);
	// Memoized on the view: `paneRows` returns new arrays on every call, and a new array rebuilds that pane's
	// tables, so a sort click would rebuild every pane's tables instead of re-sorting them.
	const contents = useMemo(
		(): PaneContent[] => [
			{ id: ALL_SLOTS_PANE, rows: paneRows(view, ALL_SLOTS_PANE) },
			...slotTabs(view).map(slot => ({ id: slot.id, slot, rows: paneRows(view, slot.id) })),
		],
		[view],
	);
	// A group that a new view takes away closes. Adjusted during render, so no frame shows it open.
	if (groupsSeenFor !== view) {
		setGroupsSeenFor(view);
		const kept = [...openGroups].filter(id => contents.some(pane => pane.id === id && pane.rows.belowCutoff.length > 0));
		if (kept.length !== openGroups.size) setOpenGroups(new Set(kept));
	}

	const subTabs: SubTab[] = contents.map(({ id, slot }) =>
		slot
			? {
					id,
					label: simSlotLabel(slot.id),
					badge: String(slot.count),
					// A slot with nothing above the cutoff keeps its tab, dimmed, so the user can open it and see why.
					className: slot.count === 0 ? 'opacity-60' : undefined,
				}
			: { id, label: i18n.t('upgrades_tab.subtabs.all_slots', { ns: 'upgrades' }) },
	);
	// A new result without the open slot falls back to the Upgrades list.
	const shownTab = subTabs.find(subTab => subTab.id === activeTab)?.id ?? ALL_SLOTS_PANE;
	// `TabNav` falls back to the tab's own value when this is undefined, which is not a pane's id, so a tab whose pane is
	// not mounted gets an empty list instead.
	const tabs: TabNavTab[] = subTabs.map(subTab => ({ ...subTab, ariaControls: subTab.id === shownTab ? paneId(subTab.id) : '' }));

	return (
		<>
			<Tabs.Root value={shownTab} onValueChange={next => setActiveTab(String(next))}>
				<TabNav tabs={tabs} testId="upgrades-results-subtabs" />
				<TabPanels>
					{contents.map(({ id, rows }) => (
						<TabPanel key={id} value={id} id={paneId(id)} keepMounted={false}>
							<ResultsPane
								rows={rows}
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
