import { Tab } from 'bootstrap';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { CURRENT_API_VERSION } from '../../constants/other.js';
import { IndividualSimUI } from '../../individual_sim_ui';
import { Spec } from '../../proto/common.js';
import { SimTab } from '../sim_tab';
import { PlayerGearSource } from './upgrades/adapters/player_gear_source';
import { currentPageSkeleton } from './upgrades/adapters/skeleton';
import { WasmSimRunner } from './upgrades/adapters/wasm_sim_runner';
import { epWeightsFor, poolFor } from './upgrades/data/data';
import { ENGINE_FORK_COMMIT } from './upgrades/engine_provenance';
import type { Assumptions } from './upgrades/engine/disclosure';
import type { ItemSource } from './upgrades/engine/pool';
import { rankUpgrades, type Progress, type Ranking, type RankInput } from './upgrades/engine/rank';
import { MemoryStore } from './upgrades/engine/seams/store';
import { SIM_ORDER, type SimOrderName } from './upgrades/engine/slots';
import type { SpecId } from './upgrades/engine/types';
import { applyView, type ViewOptions, type ViewResult, type ViewRow } from './upgrades/engine/view';

/**
 * Specs this tab can rank, per plan §2.5: "The tab renders only for specs
 * with universe data (ret, feral)." `Spec.SpecFeralCatDruid` is the DPS
 * feral spec (`proto/common.ts`) — `Spec.SpecFeralBearDruid` (tank) is a
 * different `DetectedSpecId` value the engine never produces here (see
 * engine/types.ts's doc comment on `DetectedSpecId`).
 */
const SPEC_ID_BY_PROTO_SPEC: Partial<Record<Spec, SpecId>> = {
	[Spec.SpecRetributionPaladin]: 'ret',
	[Spec.SpecFeralCatDruid]: 'feral',
};

/**
 * Sub-tab identity for the slot strip. `'shopping-list'` is the always-first
 * tab (plan §4's sub-tab 1); everything else is one `SimOrderName` per
 * populated slot. `'offhand'` is excluded — SIM_ORDER carries it, but no
 * ret/feral pool slot maps onto it (pool.ts's `simSlotsForPoolSlot` doc
 * comment says the same).
 */
type SubTabId = 'shopping-list' | SimOrderName;

type RunState =
	| { kind: 'idle' }
	| { kind: 'running'; progress: Progress }
	| { kind: 'done'; ranking: Ranking; stale: boolean }
	| { kind: 'error'; message: string }
	| { kind: 'unsupported-spec' };

export class UpgradesTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	protected shoppingListElem: HTMLElement;
	protected runButton!: HTMLButtonElement;
	protected statusElem!: HTMLElement;
	protected resultsElem!: HTMLElement;
	protected assumptionsElem!: HTMLElement;

	// Sub-tab nav + pane container refs, built once; panes are re-rendered by
	// content, not recreated, so Bootstrap's Tab instances (and their active
	// state) survive a re-render triggered by a run/staleness change.
	private tabNavElem!: HTMLUListElement;
	private tabContentElem!: HTMLDivElement;
	private readonly paneContentElems = new Map<SubTabId, HTMLElement>();
	private activeSubTab: SubTabId = 'shopping-list';

	private hideOwned = false;

	// One runner/store per tab instance, not per run: the pool's workers are
	// expensive to spin up (each is a WASM instantiation), and MemoryStore's
	// whole purpose (plan §2.5) is to dedupe identical sim requests *across*
	// runs in the same page session, not just within one.
	private readonly sim = new WasmSimRunner();
	private readonly store = new MemoryStore();
	private state: RunState = { kind: 'idle' };

	constructor(parentElem: HTMLElement, simUI: IndividualSimUI<any>) {
		super(parentElem, simUI, { identifier: 'upgrades-tab', title: i18n.t('upgrades_tab.title') });

		this.simUI = simUI;

		const shoppingListBtnRef = ref<HTMLButtonElement>();
		const shoppingListRef = ref<HTMLDivElement>();
		const tabNavRef = ref<HTMLUListElement>();
		const tabContentRef = ref<HTMLDivElement>();

		this.contentContainer.appendChild(
			<>
				<div className="upgrades-tab-left tab-panel-left">
					<div className="upgrades-tab-tabs">
						<ul ref={tabNavRef} className="nav nav-tabs" attributes={{ role: 'tablist' }}>
							<li className="nav-item" attributes={{ role: 'presentation' }}>
								<button
									className="nav-link active"
									type="button"
									attributes={{
										role: 'tab',
										// @ts-expect-error
										'aria-controls': 'upgradesShoppingListTab',
										'aria-selected': true,
									}}
									dataset={{
										bsToggle: 'tab',
										bsTarget: `#upgradesShoppingListTab`,
									}}
									ref={shoppingListBtnRef}>
									{i18n.t('upgrades_tab.subtabs.shopping_list')}
								</button>
							</li>
						</ul>
						<div ref={tabContentRef} className="tab-content">
							<div id="upgradesShoppingListTab" className="tab-pane fade active show" ref={shoppingListRef} />
						</div>
					</div>
				</div>
			</>,
		);

		this.shoppingListElem = shoppingListRef.value!;
		this.tabNavElem = tabNavRef.value!;
		this.tabContentElem = tabContentRef.value!;
		this.paneContentElems.set('shopping-list', document.createElement('div'));

		new Tab(shoppingListBtnRef.value!);
		this.tabNavElem.addEventListener('shown.bs.tab', (e) => {
			const target = (e.target as HTMLElement).dataset.bsTarget;
			const found = ([...this.paneContentElems.keys()] as SubTabId[]).find((id) => paneId(id) === target?.slice(1));
			if (found) this.activeSubTab = found;
		});

		this.buildTabContent();
		this.wireStalenessListeners();
	}

	protected buildTabContent() {
		const runButtonRef = ref<HTMLButtonElement>();
		const statusRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();
		const assumptionsRef = ref<HTMLDivElement>();

		this.shoppingListElem.appendChild(
			<div className="upgrades-shopping-list p-gap">
				<div className="upgrades-run-row d-flex align-items-center gap-2">
					<button ref={runButtonRef} className="btn btn-primary upgrades-run-button" type="button">
						{i18n.t('upgrades_tab.run')}
					</button>
					<div ref={statusRef} className="upgrades-status text-muted" />
				</div>
				<div ref={resultsRef} className="upgrades-results mt-gap" />
				<div ref={assumptionsRef} className="upgrades-assumptions mt-gap" />
			</div>,
		);

		this.runButton = runButtonRef.value!;
		this.statusElem = statusRef.value!;
		this.resultsElem = resultsRef.value!;
		this.assumptionsElem = assumptionsRef.value!;
		this.paneContentElems.set('shopping-list', this.resultsElem);

		this.runButton.addEventListener('click', () => {
			this.run().catch((err) => {
				this.setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
			});
		});

		this.render();
	}

	/**
	 * PLAN.md-style legibility rule carried over from plan §4: "on any
	 * gear/settings change, mark existing results stale — never auto-rerun a
	 * multi-second job on a checkbox." `sim.changeEmitter` already fans in
	 * settings/raid/encounter (`ui/core/sim.ts`'s constructor); gear and
	 * talents are player-level and need their own listeners.
	 */
	private wireStalenessListeners() {
		const markStale = () => {
			if (this.state.kind === 'done') {
				this.setState({ ...this.state, stale: true });
			}
		};
		this.simUI.player.gearChangeEmitter.on(markStale);
		this.simUI.player.talentsChangeEmitter.on(markStale);
		this.simUI.sim.changeEmitter.on(markStale);
	}

	private setState(next: RunState) {
		this.state = next;
		this.render();
	}

	private async run(): Promise<void> {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		if (!specId) {
			this.setState({ kind: 'unsupported-spec' });
			return;
		}

		await this.simUI.sim.waitForInit();

		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		const skeleton = currentPageSkeleton(this.simUI);
		const gearSource = new PlayerGearSource(this.simUI);

		this.setState({ kind: 'running', progress: { stage: 'resolving' } });

		const input: RankInput = {
			// PlayerGearSource ignores everything on this ref but the shape
			// itself (see that adapter's doc comment) — there is no WCL
			// character on this surface, only "the page".
			character: { region: 'US', realm: 'current-page', name: this.simUI.player.getName() || 'player' },
			spec: specId,
			maxPhase,
		};

		const ranking = await rankUpgrades(
			input,
			{
				gear: gearSource,
				sim: this.sim,
				store: this.store,
				clock: () => new Date(),
				raidSimSkeleton: skeleton,
				epWeights: epWeightsFor(specId),
				pool: poolFor(specId, maxPhase),
			},
			(progress) => {
				// Only overwrite a still-running state — a late progress tick
				// racing a state read is possible but not a completion, so it
				// must never clobber a 'done'/'error' state set after it fired.
				if (this.state.kind === 'running') this.setState({ kind: 'running', progress });
			},
		);

		this.setState({ kind: 'done', ranking, stale: false });
	}

	private render() {
		this.runButton.disabled = this.state.kind === 'running';
		this.statusElem.replaceChildren(this.statusContent());
		this.renderSubTabs();
		this.assumptionsElem.replaceChildren(this.assumptionsContent());
	}

	private statusContent(): Node {
		switch (this.state.kind) {
			case 'idle':
				return <span>{i18n.t('upgrades_tab.status.idle')}</span>;
			case 'unsupported-spec':
				return <span>{i18n.t('upgrades_tab.status.unsupported_spec')}</span>;
			case 'running':
				return <span>{progressLabel(this.state.progress)}</span>;
			case 'error':
				return <span className="text-danger">{i18n.t('upgrades_tab.status.error', { message: this.state.message })}</span>;
			case 'done': {
				const label = i18n.t('upgrades_tab.status.done', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return this.state.stale ? (
					<div className="upgrades-stale-banner alert alert-warning py-1 px-2 mb-2 d-inline-flex align-items-center gap-2">
						<span>{label}</span>
						<span>—</span>
						<strong>{i18n.t('upgrades_tab.status.stale')}</strong>
					</div>
				) : (
					<span>{label}</span>
				);
			}
		}
	}

	/**
	 * Rebuilds the slot sub-tab strip (nav + panes) whenever a ranking's slot
	 * set could have changed — i.e. after any state transition, since only a
	 * 'done' state has slots to show. The strip after 'shopping-list' is torn
	 * down and rebuilt each time rather than diffed: this idiom is copied from
	 * `DetailedResults` (tab list built once from a static array), and here
	 * the "array" is data-dependent, so the cheapest correct approach is to
	 * discard and rebuild it — the pane *content* (`this.resultsContent()`,
	 * `this.slotPaneContent()`) is still pure re-renders over the same
	 * `Ranking`, matching plan §4's "no view changes a number".
	 */
	private renderSubTabs() {
		this.resultsElem.replaceChildren(this.resultsContent());

		// Remove any previously-built slot nav items/panes; keep the
		// shopping-list nav item (first child) and pane untouched.
		while (this.tabNavElem.children.length > 1) {
			this.tabNavElem.removeChild(this.tabNavElem.lastElementChild!);
		}
		for (const id of [...this.paneContentElems.keys()]) {
			if (id === 'shopping-list') continue;
			this.paneContentElems.get(id)?.parentElement?.remove();
			this.paneContentElems.delete(id);
		}

		if (this.state.kind !== 'done') return;

		const view = applyView(this.state.ranking, this.currentViewOptions());
		const slotsPresent = slotsInView(view);
		if (slotsPresent.length === 0) return;

		for (const slot of slotsPresent) {
			const id: SubTabId = slot;
			const btnRef = ref<HTMLButtonElement>();
			this.tabNavElem.appendChild(
				<li className="nav-item" attributes={{ role: 'presentation' }}>
					<button
						ref={btnRef}
						className="nav-link"
						type="button"
						attributes={{
							role: 'tab',
							// @ts-expect-error
							'aria-controls': paneId(id),
							'aria-selected': false,
						}}
						dataset={{
							bsToggle: 'tab',
							bsTarget: `#${paneId(id)}`,
						}}>
						{slotLabel(slot)}
					</button>
				</li>,
			);
			new Tab(btnRef.value!);

			const paneRef = ref<HTMLDivElement>();
			this.tabContentElem.appendChild(<div id={paneId(id)} className="tab-pane fade" ref={paneRef} />);
			const paneElem = paneRef.value!;
			this.paneContentElems.set(id, paneElem);
			paneElem.replaceChildren(this.slotPaneContent(slot, view));
		}
	}

	private currentViewOptions(): ViewOptions {
		return { hideOwned: this.hideOwned };
	}

	private resultsContent(): Node {
		if (this.state.kind !== 'done') return <></>;
		const view = applyView(this.state.ranking, this.currentViewOptions());
		return this.rowsTable(view.shortlist, view.belowCutoffCount, view.rows);
	}

	private slotPaneContent(slot: SimOrderName, view: ViewResult): Node {
		const rowsForSlot = view.rows.filter((r) => (r.slotChoice ?? r.slot) === slot);
		const shortlistForSlot = rowsForSlot.filter((r) => !r.belowCutoffInView);
		const belowCutoffForSlot = rowsForSlot.length - shortlistForSlot.length;
		return <div className="p-gap">{this.rowsTable(shortlistForSlot, belowCutoffForSlot, rowsForSlot)}</div>;
	}

	/**
	 * Shared table renderer for the shopping list and every slot pane — same
	 * columns, same cutoff-behind-expand behaviour (plan §4), parameterized
	 * only by which rows to show.
	 */
	private rowsTable(shortlist: ViewRow[], belowCutoffCount: number, allRows: ViewRow[]): Node {
		if (shortlist.length === 0 && belowCutoffCount === 0) {
			return <div className="text-muted">{i18n.t('upgrades_tab.results.empty')}</div>;
		}
		const toggleRef = ref<HTMLButtonElement>();
		const table = (
			<table className="upgrades-results-table table table-sm">
				<thead>
					<tr>
						<th>{i18n.t('upgrades_tab.results.rank')}</th>
						<th>{i18n.t('upgrades_tab.results.item')}</th>
						<th>{i18n.t('upgrades_tab.results.slot')}</th>
						<th>{i18n.t('upgrades_tab.results.delta_dps')}</th>
						<th>{i18n.t('upgrades_tab.results.source')}</th>
					</tr>
				</thead>
				<tbody>
					{shortlist.length > 0 ? (
						shortlist.map((row) => this.resultRow(row))
					) : (
						<tr>
							<td colSpan={5} className="text-muted">
								{i18n.t('upgrades_tab.results.empty')}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		);
		if (belowCutoffCount === 0) return table;

		const belowRows = allRows.filter((r) => r.belowCutoffInView);
		const belowTbodyRef = ref<HTMLTableSectionElement>();
		const belowTable = (
			<table className="upgrades-results-table upgrades-below-cutoff-table table table-sm d-none">
				<tbody ref={belowTbodyRef} />
			</table>
		);
		belowTbodyRef.value!.replaceChildren(...belowRows.map((row) => this.resultRow(row)));

		return (
			<>
				{table}
				<button
					ref={toggleRef}
					type="button"
					className="btn btn-sm btn-outline-secondary upgrades-below-cutoff-toggle"
					onclick={() => {
						const below = belowTable as HTMLElement;
						const nowShown = below.classList.toggle('d-none') === false;
						toggleRef.value!.textContent = nowShown
							? i18n.t('upgrades_tab.results.below_cutoff_toggle_hide')
							: i18n.t('upgrades_tab.results.below_cutoff_toggle_show', { count: belowCutoffCount });
					}}>
					{i18n.t('upgrades_tab.results.below_cutoff_toggle_show', { count: belowCutoffCount })}
				</button>
				{belowTable}
			</>
		);
	}

	private resultRow(row: ViewRow): Node {
		const bisLabel = row.bisTags.includes('BiS') ? ' ★ BiS' : row.bisTags.includes('Alt') ? ' Alt' : '';
		return (
			<tr className={row.owned ? 'upgrades-row-owned text-muted' : ''}>
				<td>{row.rank ?? '—'}</td>
				<td>
					{row.name}
					{bisLabel}
					{row.owned ? ` (${i18n.t('upgrades_tab.results.owned')})` : ''}
				</td>
				<td>{row.slotChoice ?? row.slot}</td>
				<td>{`+${row.deltaDps.toFixed(1)}`}</td>
				<td>{sourceLabel(row.source)}</td>
			</tr>
		);
	}

	private assumptionsContent(): Node {
		if (this.state.kind !== 'done') return <></>;
		const a: Assumptions = this.state.ranking.assumptions;
		const detailsRef = ref<HTMLDetailsElement>();
		return (
			<details ref={detailsRef} className="upgrades-assumptions-drawer">
				<summary>{i18n.t('upgrades_tab.assumptions.title')}</summary>
				<dl className="row mb-0">
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.seeds')}</dt>
					<dd className="col-sm-8">{a.seeds.join(', ')}</dd>
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.iterations')}</dt>
					<dd className="col-sm-8">{a.iterations}</dd>
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.max_phase')}</dt>
					<dd className="col-sm-8">{a.maxPhase}</dd>
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.engine_provenance')}</dt>
					<dd className="col-sm-8">{ENGINE_FORK_COMMIT}</dd>
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.sim_version')}</dt>
					<dd className="col-sm-8">{`api-v${CURRENT_API_VERSION}`}</dd>
				</dl>
			</details>
		);
	}
}

function paneId(id: SubTabId): string {
	return id === 'shopping-list' ? 'upgradesShoppingListTab' : `upgradesSlot-${id}`;
}

function slotLabel(slot: SimOrderName): string {
	return SLOT_LABELS[slot] ?? slot;
}

const SLOT_LABELS: Record<SimOrderName, string> = {
	head: 'Head',
	neck: 'Neck',
	shoulder: 'Shoulder',
	back: 'Back',
	chest: 'Chest',
	wrist: 'Wrist',
	hands: 'Hands',
	waist: 'Waist',
	legs: 'Legs',
	feet: 'Feet',
	finger1: 'Finger 1',
	finger2: 'Finger 2',
	trinket1: 'Trinket 1',
	trinket2: 'Trinket 2',
	mainhand: 'Main Hand',
	offhand: 'Off Hand',
	ranged: 'Ranged',
};

/** Slots with at least one ranked candidate, in SIM_ORDER (stable, matches the page's own gear ordering). */
function slotsInView(view: ViewResult): SimOrderName[] {
	const present = new Set<SimOrderName>();
	for (const row of view.rows) present.add((row.slotChoice ?? row.slot) as SimOrderName);
	return SIM_ORDER.filter((s) => present.has(s));
}

const SOURCE_LABELS: Record<string, string> = {
	badge: 'Badge vendor',
	crafted: 'Crafted',
	rep: 'Reputation vendor',
	pvp: 'PvP vendor',
	world: 'World drop',
	heroic: 'Heroic dungeon',
	unknown: 'Source not recorded',
};

function sourceLabel(source: ItemSource): string {
	if ('zone' in source) return source.zone;
	return SOURCE_LABELS[source.kind] ?? source.kind;
}

function progressLabel(p: Progress): string {
	switch (p.stage) {
		case 'resolving':
			return i18n.t('upgrades_tab.progress.resolving');
		case 'reading-gear':
			return i18n.t('upgrades_tab.progress.reading_gear');
		case 'composing':
			return i18n.t('upgrades_tab.progress.composing');
		case 'building-pool':
			return i18n.t('upgrades_tab.progress.building_pool');
		case 'simming':
			return i18n.t('upgrades_tab.progress.simming', { done: p.done, total: p.total });
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking');
	}
}
