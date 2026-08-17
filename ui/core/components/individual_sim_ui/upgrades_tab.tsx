import { Tab } from 'bootstrap';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { CURRENT_API_VERSION } from '../../constants/other.js';
import { IndividualSimUI } from '../../individual_sim_ui';
import { Spec } from '../../proto/common.js';
import { SimTab } from '../sim_tab';
import { PlayerGearSource } from './upgrades/adapters/player_gear_source';
import { currentPageSkeleton } from './upgrades/adapters/skeleton';
import { simDatabaseFor } from './upgrades/adapters/sim_database';
import { WasmSimRunner } from './upgrades/adapters/wasm_sim_runner';
import { epWeightsFor, poolFor } from './upgrades/data/data';
import { isKaelTempLegendary } from './upgrades/engine/kael-temp';
import { filterPoolByPhase } from './upgrades/engine/pool';
import { ENGINE_FORK_COMMIT } from './upgrades/engine_provenance';
import { WclGearImportModal } from './upgrades/wcl_import_modal';
import type { Assumptions } from './upgrades/engine/disclosure';
import type { ItemSource } from './upgrades/engine/pool';
import { simSlotsForPoolSlot } from './upgrades/engine/pool';
import { rankUpgrades, type PartialRanking, type Progress, type Ranking, type RankInput } from './upgrades/engine/rank';
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

/**
 * Mirrors `rank.ts`'s own `DEFAULT_ITERATIONS` (not exported — engine code,
 * out of scope per plan §1). D7 asks for "3,000 with a visible control";
 * this is only the control's default display value, not a fallback used
 * when the field is empty (see `run()`, which always sends a parsed number).
 */
const DEFAULT_ITERATIONS = 3000;

type RunState =
	| { kind: 'idle' }
	| { kind: 'running'; progress: Progress }
	| { kind: 'done'; ranking: Ranking; stale: boolean }
	/**
	 * Stop (candidate-pool.md §5.1.4) cut the run short — `ranking.complete`
	 * is `false` by construction (`PartialRanking`), kept as its own `RunState`
	 * branch rather than folded into `'done'` so a renderer cannot forget to
	 * check `complete` before treating the numbers as final. `applyView`
	 * (view.ts) only accepts a `complete: true` `Ranking`, so this state's
	 * own render path builds its own row list from `ranking.items` rather
	 * than calling `applyView`.
	 */
	| { kind: 'stopped'; ranking: PartialRanking }
	| { kind: 'error'; message: string }
	| { kind: 'unsupported-spec' };

export class UpgradesTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	protected shoppingListElem: HTMLElement;
	protected runButton!: HTMLButtonElement;
	protected stopButton!: HTMLButtonElement;
	protected importButton!: HTMLButtonElement;
	protected iterationsInput!: HTMLInputElement;
	protected candidatesInput!: HTMLInputElement;
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

	// One runner/store per tab instance, not per run: the pool's workers are
	// expensive to spin up (each is a WASM instantiation), and MemoryStore's
	// whole purpose (plan §2.5) is to dedupe identical sim requests *across*
	// runs in the same page session, not just within one.
	private readonly sim = new WasmSimRunner();
	private readonly store = new MemoryStore();

	// Rebuilt each run (an AbortController cannot be reused after abort) —
	// held on the instance so the Stop button's click handler can reach the
	// signal for whichever run is currently in flight (candidate-pool.md
	// §5.1.4).
	private abortController: AbortController | undefined;
	// Rows land one at a time via the `{ kind: 'row' }` Progress event
	// (candidate-pool.md §5.1.5); accumulated here so a re-render mid-run can
	// show a skeleton filling in rather than nothing until the whole run
	// finishes.
	private landedRows: Ranking['items'] = [];
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
		const stopButtonRef = ref<HTMLButtonElement>();
		const importButtonRef = ref<HTMLButtonElement>();
		const iterationsInputRef = ref<HTMLInputElement>();
		const candidatesInputRef = ref<HTMLInputElement>();
		const statusRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();
		const assumptionsRef = ref<HTMLDivElement>();

		this.shoppingListElem.appendChild(
			<div className="upgrades-shopping-list p-gap">
				<div className="upgrades-run-row d-flex align-items-center gap-2">
					<button ref={runButtonRef} className="btn btn-primary upgrades-run-button" type="button">
						{i18n.t('upgrades_tab.run')}
					</button>
					<button ref={stopButtonRef} className="btn btn-outline-danger upgrades-stop-button" type="button" disabled>
						{i18n.t('upgrades_tab.stop')}
					</button>
					<button ref={importButtonRef} className="btn btn-outline-secondary upgrades-import-button" type="button">
						{i18n.t('upgrades_tab.import_wcl')}
					</button>
					<label className="upgrades-iterations-label d-flex align-items-center gap-1 mb-0">
						{i18n.t('upgrades_tab.iterations_label')}
						<input
							ref={iterationsInputRef}
							type="number"
							min="1"
							step="1"
							className="upgrades-iterations-input form-control form-control-sm"
							value={String(DEFAULT_ITERATIONS)}
						/>
					</label>
					<label className="upgrades-candidates-label d-flex align-items-center gap-1 mb-0">
						{i18n.t('upgrades_tab.candidates_label')}
						<input
							ref={candidatesInputRef}
							type="number"
							min="1"
							step="1"
							className="upgrades-candidates-input form-control form-control-sm"
							// Placeholder, not a value: the real default is "every
							// eligible candidate", which depends on the selected
							// spec/maxPhase and is not known until Run is clicked
							// (readCandidateCap() below re-derives it then). An empty
							// input reads as "no cap" — matching RankInput.candidateCap's
							// own `undefined` meaning (candidate-pool.md §5.1.1).
							placeholder={i18n.t('upgrades_tab.candidates_placeholder')}
						/>
					</label>
					<div ref={statusRef} className="upgrades-status text-muted" />
				</div>
				<div ref={resultsRef} className="upgrades-results mt-gap" />
				<div ref={assumptionsRef} className="upgrades-assumptions mt-gap" />
			</div>,
		);

		this.runButton = runButtonRef.value!;
		this.stopButton = stopButtonRef.value!;
		this.importButton = importButtonRef.value!;
		this.iterationsInput = iterationsInputRef.value!;
		this.candidatesInput = candidatesInputRef.value!;
		this.statusElem = statusRef.value!;
		this.resultsElem = resultsRef.value!;
		this.assumptionsElem = assumptionsRef.value!;
		this.paneContentElems.set('shopping-list', this.resultsElem);

		this.runButton.addEventListener('click', () => {
			this.run().catch((err) => {
				this.setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
			});
		});

		// Stop's contract (candidate-pool.md §5.1.4) is "finish in-flight work,
		// dispatch nothing new" — signalling the abort is all this button does;
		// rankUpgrades itself decides what "in-flight" means and returns the
		// PartialRanking, so there is nothing else for the click handler to do.
		this.stopButton.addEventListener('click', () => {
			this.abortController?.abort();
		});

		// Gear-only import (plan §6, slice 5): opens its own modal rather than
		// registering as a header import link, because it applies only
		// `player.equipment` — the header importers (JSON/60U/WoWHead/Addon)
		// all apply race/talents/professions too, which this deliberately does
		// not (E-W4 binds the application call to plain `setGear`).
		this.importButton.addEventListener('click', () => {
			new WclGearImportModal(this.simUI.rootElem, this.simUI).open();
		});

		// Before this, the field showed its raw `{{count}}` template until a
		// run finished (ticket 210).
		this.refreshCandidatesPlaceholder();
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
			// The Candidates placeholder describes the pool the *next* run will
			// use, so it has to follow the phase/spec selection rather than the
			// last finished run (ticket 210). Refreshed here as well as at
			// construction because the phase picker lives in the gear-slot item
			// modal, and changing it fires through this same emitter.
			this.refreshCandidatesPlaceholder();
		};
		this.simUI.player.gearChangeEmitter.on(markStale);
		this.simUI.player.talentsChangeEmitter.on(markStale);
		this.simUI.sim.changeEmitter.on(markStale);
	}

	/**
	 * Writes the eligible-candidate count into the Candidates placeholder.
	 *
	 * Two defects this fixes (ticket 210). The placeholder was interpolated
	 * only inside `run()`, so before the first run the field rendered its raw
	 * i18n template — a literal `{{count}}` on screen — and afterwards it
	 * showed the pool of the run that had just *finished*, lagging a run
	 * behind the selection it appears to describe. `eligibleCount` is a pure
	 * synchronous filter over the bundled pool, so there was never a reason to
	 * wait for a run: the count is knowable the moment a spec and phase are.
	 *
	 * Unsupported specs have no pool to count, so the field keeps a plain
	 * "no cap" placeholder rather than showing a misleading zero.
	 */
	private refreshCandidatesPlaceholder() {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		if (!specId) {
			this.candidatesInput.placeholder = i18n.t('upgrades_tab.candidates_placeholder_uncapped');
			return;
		}
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		this.candidatesInput.placeholder = i18n.t('upgrades_tab.candidates_placeholder', {
			count: this.eligibleCount(specId, maxPhase),
		});
	}

	private setState(next: RunState) {
		this.state = next;
		this.render();
	}

	/**
	 * Reads the visible iterations control (D7) at click-time only — the
	 * field itself is a plain number input with no change listener, so
	 * editing it never triggers a sim or touches `this.state`; it only
	 * changes what the *next* `run()` sends. Falls back to the same default
	 * the engine uses when the field is empty or not a positive integer.
	 */
	private readIterations(): number {
		const parsed = Number(this.iterationsInput.value);
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_ITERATIONS;
	}

	/**
	 * Eligible-candidate count for the current spec/maxPhase — the same
	 * phase + Kael-legendary filter `rank.ts` itself applies before EP
	 * ordering (candidate-pool.md F1), so the placeholder's denominator
	 * ("246 / 246") always matches what an uncapped run would actually sim.
	 * Recomputed per call rather than cached: it depends on the page's
	 * current spec and phase, both of which can change between runs.
	 */
	private eligibleCount(specId: SpecId, maxPhase: RankInput['maxPhase']): number {
		return filterPoolByPhase(poolFor(specId, maxPhase), maxPhase).filter((e) => !isKaelTempLegendary(e.itemId)).length;
	}

	/**
	 * Reads the Candidates control (candidate-pool.md §5.1.1) at click-time,
	 * same idiom as `readIterations`. An empty field means "no cap" —
	 * `RankInput.candidateCap: undefined`, sim every eligible candidate —
	 * matching the field's own placeholder text rather than silently
	 * defaulting to some other number the user never typed. A non-positive
	 * or non-finite value is treated the same way: refusing to rank rather
	 * than guessing is wrong here, but there is no error channel before
	 * `rankUpgrades` starts, so "no cap" is the safe fallback (never simming
	 * fewer candidates than the user could see was intended).
	 */
	private readCandidateCap(): number | undefined {
		const raw = this.candidatesInput.value.trim();
		if (raw === '') return undefined;
		const parsed = Number(raw);
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
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

		// Kept in step with the selection by `refreshCandidatesPlaceholder`
		// (construction + every settings change), not written here — a value
		// set at run time could only ever describe the run just started.
		this.abortController = new AbortController();
		this.landedRows = [];
		this.setState({ kind: 'running', progress: { stage: 'resolving' } });

		const input: RankInput = {
			// PlayerGearSource ignores everything on this ref but the shape
			// itself (see that adapter's doc comment) — there is no WCL
			// character on this surface, only "the page".
			character: { region: 'US', realm: 'current-page', name: this.simUI.player.getName() || 'player' },
			spec: specId,
			maxPhase,
			iterations: this.readIterations(),
			candidateCap: this.readCandidateCap(),
		};

		this.stopButton.disabled = false;
		let ranking: Ranking | PartialRanking;
		try {
			ranking = await rankUpgrades(
				input,
				{
					gear: gearSource,
					sim: this.sim,
					store: this.store,
					clock: () => new Date(),
					raidSimSkeleton: skeleton,
					epWeights: epWeightsFor(specId),
					pool: poolFor(specId, maxPhase),
					simDatabaseFor,
					// `min(workers, memoryCap)` — WasmSimRunner derives this once at
					// construction from the measured per-process memory cost
					// (candidate-pool.md §5.1.2, wasm_sim_runner.ts).
					concurrency: this.sim.concurrency,
					signal: this.abortController.signal,
				},
				(progress) => {
					// Row-landed events (candidate-pool.md §5.1.5) are a side
					// channel alongside the stage sequence, not a stage of their
					// own — accumulate them for the skeleton fill and keep
					// rendering the current 'running' stage/progress underneath.
					if ('kind' in progress && progress.kind === 'row') {
						this.landedRows.push(progress.row);
						if (this.state.kind === 'running') this.render();
						return;
					}
					// Only overwrite a still-running state — a late progress tick
					// racing a state read is possible but not a completion, so it
					// must never clobber a 'done'/'error'/'stopped' state set
					// after it fired.
					if (this.state.kind === 'running') this.setState({ kind: 'running', progress });
				},
			);
		} finally {
			this.stopButton.disabled = true;
			this.abortController = undefined;
		}

		if (ranking.complete) {
			this.setState({ kind: 'done', ranking, stale: false });
		} else {
			// Stop cut the run short — `ranking.complete` narrows to `false`
			// here, so this is a `PartialRanking` by the type, not by
			// convention. Never reaches the ranking cache (rank.ts's own
			// `complete: true`-only cache write), so a later re-run recomputes
			// rather than replaying the partial result.
			this.setState({ kind: 'stopped', ranking });
		}
	}

	private render() {
		this.runButton.disabled = this.state.kind === 'running';
		this.stopButton.disabled = this.state.kind !== 'running';
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
				// Row-landed count (candidate-pool.md §5.1.5), not just the stage
				// label — "Simming 12/246" is more useful mid-run than the stage
				// name alone, and `landedRows` is exactly the rows that fired a
				// `{ kind: 'row' }` event so far.
				return <span>{`${progressLabel(this.state.progress)} (${this.landedRows.length} rows landed)`}</span>;
			case 'error':
				return <span className="text-danger">{i18n.t('upgrades_tab.status.error', { message: this.state.message })}</span>;
			case 'stopped': {
				const label = i18n.t('upgrades_tab.status.stopped', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return (
					<div className="upgrades-stopped-banner alert alert-warning py-1 px-2 mb-2 d-inline-flex align-items-center gap-2">
						<span>{label}</span>
					</div>
				);
			}
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

		const buttonById = new Map<SubTabId, HTMLButtonElement>();

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
			buttonById.set(id, btnRef.value!);

			const paneRef = ref<HTMLDivElement>();
			this.tabContentElem.appendChild(<div id={paneId(id)} className="tab-pane fade" ref={paneRef} />);
			const paneElem = paneRef.value!;
			this.paneContentElems.set(id, paneElem);
			paneElem.replaceChildren(this.slotPaneContent(slot, view));
		}

		// Re-select whichever sub-tab the user was last on, so a
		// staleness-driven rebuild (F2, .scratch/handoffs/wowsims-tab/
		// slice-3-4-review.md) doesn't bounce them back to Shopping List.
		// Falls back to Shopping List when the remembered slot no longer has
		// candidates (e.g. it was greyed out of the ranking entirely).
		const restoreId: SubTabId = this.activeSubTab !== 'shopping-list' && buttonById.has(this.activeSubTab) ? this.activeSubTab : 'shopping-list';
		if (restoreId !== 'shopping-list') {
			new Tab(buttonById.get(restoreId)!).show();
		}
	}

	private currentViewOptions(): ViewOptions {
		// Owned rows are greyed, not hidden — plan §4's sub-tab 1 list does not
		// ask for a hide toggle, so this is fixed rather than user-controlled.
		return { hideOwned: false };
	}

	private resultsContent(): Node {
		if (this.state.kind === 'running') {
			// Skeleton fill (candidate-pool.md §5.1.5): show rows as they land
			// rather than nothing until the whole run finishes. Not run through
			// applyView — there is no complete Ranking yet to view, only the
			// individual rows the row-landed Progress event has delivered.
			return this.landedRowsTable(this.landedRows);
		}
		if (this.state.kind === 'stopped') {
			// PartialRanking is not a Ranking (`complete: false` vs the `true`
			// literal applyView's parameter requires), so this renders directly
			// from `ranking.items` rather than going through applyView/the slot
			// tab strip — a stopped run gets the plain list its own state
			// deserves, not a pretend-complete view (candidate-pool.md §5.1.4).
			return this.landedRowsTable(this.state.ranking.items);
		}
		if (this.state.kind !== 'done') return <></>;
		const view = applyView(this.state.ranking, this.currentViewOptions());
		return this.rowsTable(view.shortlist, view.rows);
	}

	/**
	 * Plain row list for states with no complete `Ranking` to run through
	 * `applyView` — mid-run skeleton fill and the Stop-truncated result
	 * (candidate-pool.md §5.1.4, §5.1.5). Rows Stop never reached
	 * (`simmed: false`) are filtered out here rather than shown with a
	 * placeholder 0 delta, which would misread as "no upgrade" instead of
	 * "not simmed".
	 */
	private landedRowsTable(rows: readonly Ranking['items'][number][]): Node {
		const simmedRows = rows.filter((r) => r.simmed !== false);
		if (simmedRows.length === 0) {
			return <div className="text-muted">{i18n.t('upgrades_tab.results.empty')}</div>;
		}
		return (
			<table className="upgrades-results-table table table-sm">
				<thead>
					<tr>
						<th>{i18n.t('upgrades_tab.results.item')}</th>
						<th>{i18n.t('upgrades_tab.results.slot')}</th>
						<th>{i18n.t('upgrades_tab.results.delta_dps')}</th>
						<th>{i18n.t('upgrades_tab.results.source')}</th>
					</tr>
				</thead>
				<tbody>
					{simmedRows.map((row) => (
						<tr className={row.owned ? 'upgrades-row-owned text-muted' : ''}>
							<td>{row.name}</td>
							<td>{slotLabel(row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0])}</td>
							<td>{`+${row.deltaDps.toFixed(1)}`}</td>
							<td>{sourceLabel(row.source)}</td>
						</tr>
					))}
				</tbody>
			</table>
		);
	}

	private slotPaneContent(slot: SimOrderName, view: ViewResult): Node {
		const rowsForSlot = view.rows.filter((r) => effectiveSlot(r) === slot);
		const shortlistForSlot = rowsForSlot.filter((r) => !r.belowCutoffInView);
		return <div className="p-gap">{this.rowsTable(shortlistForSlot, rowsForSlot)}</div>;
	}

	/**
	 * Shared table renderer for the shopping list and every slot pane — same
	 * columns, same cutoff-behind-expand behaviour (plan §4), parameterized
	 * only by which rows to show.
	 *
	 * Screened rows (candidate-pool.md §6.1 M2 racing) get their **own**
	 * expand, separate from the below-cutoff one: a screened row was never
	 * measured at full precision, which is a different fact from "measured
	 * and small" — collapsing the two into one toggle would let a reader
	 * conflate "this item is a small upgrade" with "this item's size is
	 * unknown". `view.ts` already routes every screened row through
	 * `belowCutoffInView: true` (so it never appears in `shortlist`), so
	 * this only needs to split `allRows`'s below-cutoff set by `screened`
	 * membership, not add a new filter of its own.
	 */
	private rowsTable(shortlist: ViewRow[], allRows: ViewRow[]): Node {
		const screenedRows = allRows.filter((r) => r.screened !== undefined);
		const belowCutoffRows = allRows.filter((r) => r.belowCutoffInView && r.screened === undefined);
		if (shortlist.length === 0 && belowCutoffRows.length === 0 && screenedRows.length === 0) {
			return <div className="text-muted">{i18n.t('upgrades_tab.results.empty')}</div>;
		}
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

		return (
			<>
				{table}
				{belowCutoffRows.length > 0 ? this.expandableRowGroup(belowCutoffRows, 'below-cutoff') : null}
				{screenedRows.length > 0 ? this.expandableRowGroup(screenedRows, 'screened') : null}
			</>
		);
	}

	/**
	 * One hidden-behind-a-toggle table, shared shape for both the
	 * below-cutoff expand and the screened-rows expand (candidate-pool.md
	 * §6.1: "renders behind its own expand", "hidden, never deleted") — the
	 * two are kept as separate calls (never merged into one row set) so
	 * their toggle labels and row counts stay honest about which claim each
	 * one makes.
	 */
	private expandableRowGroup(rows: ViewRow[], kind: 'below-cutoff' | 'screened'): Node {
		const toggleRef = ref<HTMLButtonElement>();
		const tbodyRef = ref<HTMLTableSectionElement>();
		const showKey = kind === 'below-cutoff' ? 'upgrades_tab.results.below_cutoff_toggle_show' : 'upgrades_tab.results.screened_toggle_show';
		const hideKey = kind === 'below-cutoff' ? 'upgrades_tab.results.below_cutoff_toggle_hide' : 'upgrades_tab.results.screened_toggle_hide';
		const groupTable = (
			<table className={`upgrades-results-table upgrades-${kind}-table table table-sm d-none`}>
				<tbody ref={tbodyRef} />
			</table>
		);
		tbodyRef.value!.replaceChildren(...rows.map((row) => this.resultRow(row)));

		return (
			<>
				<button
					ref={toggleRef}
					type="button"
					className={`btn btn-sm btn-outline-secondary upgrades-${kind}-toggle`}
					onclick={() => {
						const group = groupTable as HTMLElement;
						const nowShown = group.classList.toggle('d-none') === false;
						toggleRef.value!.textContent = nowShown ? i18n.t(hideKey) : i18n.t(showKey, { count: rows.length });
					}}>
					{i18n.t(showKey, { count: rows.length })}
				</button>
				{groupTable}
			</>
		);
	}

	private resultRow(row: ViewRow): Node {
		const bisLabel = row.bisTags.includes('BiS') ? ' ★ BiS' : row.bisTags.includes('Alt') ? ' Alt' : '';
		// A screened row's deltaDps is a screening-iteration observation, not
		// a full-iteration one (candidate-pool.md §6.1) — labelled distinctly
		// so a reader never reads it as directly comparable to a full row's
		// delta in the same column.
		const deltaLabel =
			row.screened !== undefined ? i18n.t('upgrades_tab.results.screened_delta_dps', { value: row.deltaDps.toFixed(1) }) : `+${row.deltaDps.toFixed(1)}`;
		return (
			<tr className={row.owned ? 'upgrades-row-owned text-muted' : ''}>
				<td>{row.rank ?? '—'}</td>
				<td>
					{row.name}
					{bisLabel}
					{row.owned ? ` (${i18n.t('upgrades_tab.results.owned')})` : ''}
				</td>
				<td>{slotLabel(effectiveSlot(row))}</td>
				<td>{deltaLabel}</td>
				<td>{sourceLabel(row.source)}</td>
			</tr>
		);
	}

	private assumptionsContent(): Node {
		if (this.state.kind !== 'done' && this.state.kind !== 'stopped') return <></>;
		const a: Assumptions = this.state.ranking.assumptions;
		const cap = this.readCandidateCap();
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
					{cap !== undefined ? (
						<>
							<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.candidate_cap')}</dt>
							{/* Racing IS shipped and is always on here: the tab never sets
							    `fullPool`, so `rank.ts`'s `input.fullPool !== true` is true
							    on every browser run. The whole eligible pool is screened at
							    DEFAULT_SCREEN_ITERATIONS, the promotion rule runs, and the
							    cap applies to the promoted set. The CLI is the surface that
							    never races (`cli.ts` hardcodes `fullPool: true`), which is
							    why this note survived saying the opposite (ticket 209).
							    Which order the cap slices within the promoted set is
							    ticket 208 — stated as EP here because that is what the code
							    does today, not as an endorsement of it. */}
							<dd className="col-sm-8">{i18n.t('upgrades_tab.assumptions.candidate_cap_note', { cap })}</dd>
						</>
					) : null}
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.engine_provenance')}</dt>
					<dd className="col-sm-8">{ENGINE_FORK_COMMIT}</dd>
					<dt className="col-sm-4">{i18n.t('upgrades_tab.assumptions.sim_version')}</dt>
					<dd className="col-sm-8">{`api-v${CURRENT_API_VERSION}`}</dd>
				</dl>
				{this.substitutionsContent()}
			</details>
		);
	}

	/**
	 * Every candidate the run dropped, and why. Nothing rendered these before
	 * (ticket 156): the engine has always recorded dropped candidates in
	 * `substitutions`, but the drawer showed only the run's settings, so a run
	 * that lost candidates to sim panics looked identical on the page to one
	 * where every candidate simmed cleanly. That is what let a fully failed
	 * screening pass read as "no upgrades found above the cutoff".
	 */
	private substitutionsContent(): Node {
		if (this.state.kind !== 'done' && this.state.kind !== 'stopped') return <></>;
		const subs = this.state.ranking.substitutions;
		if (subs.length === 0) return <></>;
		return (
			<>
				<hr />
				<p className="mb-1">
					<strong>{i18n.t('upgrades_tab.assumptions.substitutions_title', { count: subs.length })}</strong>
				</p>
				<dl className="row mb-0 upgrades-substitutions">
					{subs.map(s => (
						<>
							<dt className="col-sm-4">{s.field}</dt>
							<dd className="col-sm-8">{s.detail}</dd>
						</>
					))}
				</dl>
			</>
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

/**
 * A row's effective sim-order slot, for tab-strip grouping. `row.slotChoice`
 * wins when the engine set it (finger/trinket, which fan out to two sim
 * slots); otherwise resolve through `simSlotsForPoolSlot`, which always
 * returns at least one slot name — including for `weapon`, whose single
 * mapped slot (`mainhand`) `slotChoice` never carries because `rank.ts` only
 * sets it when the mapped list has more than one entry (F1,
 * .scratch/handoffs/wowsims-tab/slice-3-4-review.md). Casting `row.slot`
 * itself to `SimOrderName` is unsound: it is a pool `ItemSlot`, and
 * `weapon`/`finger`/`trinket` are not `SIM_ORDER` members.
 */
function effectiveSlot(row: ViewRow): SimOrderName {
	return row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0];
}

/** Slots with at least one ranked candidate, in SIM_ORDER (stable, matches the page's own gear ordering). */
function slotsInView(view: ViewResult): SimOrderName[] {
	const present = new Set<SimOrderName>();
	for (const row of view.rows) present.add(effectiveSlot(row));
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

/** Narrows away the `{ kind: 'row' }` side channel, which carries no `stage`. */
type StageProgress = Exclude<Progress, { kind: 'row' }>;

function isStageProgress(p: Progress): p is StageProgress {
	return !('kind' in p);
}

function progressLabel(p: Progress): string {
	// The `{ kind: 'row' }` side channel (candidate-pool.md §5.1.5) never
	// reaches `RunState.running.progress` — `run()`'s onProgress callback
	// intercepts it and updates `landedRows` instead of calling `setState`
	// — but `Progress`'s type still includes it, so this branch exists for
	// exhaustiveness rather than because it is ever rendered.
	if (!isStageProgress(p)) return i18n.t('upgrades_tab.progress.resolving');
	switch (p.stage) {
		case 'resolving':
			return i18n.t('upgrades_tab.progress.resolving');
		case 'reading-gear':
			return i18n.t('upgrades_tab.progress.reading_gear');
		case 'composing':
			return i18n.t('upgrades_tab.progress.composing');
		case 'building-pool':
			return i18n.t('upgrades_tab.progress.building_pool');
		// Failures are named in the status line as they happen, not just
		// counted at the end (ticket 156): a screening pass that is losing
		// every candidate used to look identical to one finding no upgrade,
		// and the run took minutes before saying anything at all.
		case 'screening':
			return p.failed > 0
				? i18n.t('upgrades_tab.progress.screening_with_failures', { done: p.done, total: p.total, failed: p.failed })
				: i18n.t('upgrades_tab.progress.screening', { done: p.done, total: p.total });
		case 'simming':
			return i18n.t('upgrades_tab.progress.simming', { done: p.done, total: p.total });
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking');
	}
}
