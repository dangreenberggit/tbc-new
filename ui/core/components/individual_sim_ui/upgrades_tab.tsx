import { Tab } from 'bootstrap';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { setItemQualityCssClass } from '../../css_utils';
import { CURRENT_API_VERSION } from '../../constants/other.js';
import { IndividualSimUI } from '../../individual_sim_ui';
import { Spec } from '../../proto/common.js';
import { ActionId } from '../../proto_utils/action_id';
import { Database } from '../../proto_utils/database.js';
import { CopyButton } from '../copy_button';
import { getSourceInfo } from '../gear_picker/item_list';
import { makePhaseSelector } from '../inputs/other_inputs';
import { BooleanPicker } from '../pickers/boolean_picker';
import { NumberPicker } from '../pickers/number_picker';
import { TypedEvent } from '../../typed_event';
import { SimTab } from '../sim_tab';
import { PlayerGearSource } from './upgrades/adapters/player_gear_source';
import { currentPageSkeleton } from './upgrades/adapters/skeleton';
import { simDatabaseResolverFor } from './upgrades/adapters/sim_database';
import { BulkHttpSimRunner } from './upgrades/adapters/bulk_http_sim_runner';
import { makeSimRunner } from './upgrades/adapters/bulk_wasm_sim_runner';
import { WasmSimRunner } from './upgrades/adapters/wasm_sim_runner';
import { WorkerPool } from '../../worker_pool';
import { bisTagPhaseFor, cutoffIsUnmeasuredFor, epWeightsDisclosureFor, epWeightsFor, poolFor, poolSourceFor, unsourcedCountFor } from './upgrades/data/data';
import { isKaelTempLegendary } from './upgrades/engine/kael-temp';
import { filterPoolByPhase } from './upgrades/engine/pool';
import { ENGINE_FORK_COMMIT } from './upgrades/engine_provenance';
import type { Assumptions } from './upgrades/engine/disclosure';
import type { ItemSource } from './upgrades/engine/pool';
import { simSlotsForPoolSlot } from './upgrades/engine/pool';
import { rankUpgrades, type PartialRanking, type Progress, type Ranking, type RankedItem, type RankInput } from './upgrades/engine/rank';
import { MemoryStore } from './upgrades/engine/seams/store';
import { SIM_ORDER, type SimOrderName } from './upgrades/engine/slots';
import type { ContentPhase, SpecId } from './upgrades/engine/types';
import { applyView, raidFilterGroups, SOURCE_LABELS, type ViewOptions, type ViewResult, type ViewRow } from './upgrades/engine/view';
import { cutoffAdmittingArm, setBonusNoiseFloorDps, type Cutoff } from './upgrades/engine/cutoff';

/**
 * Specs this tab can rank, per plan §2.5: "The tab renders only for specs
 * with universe data (ret, feral)." `Spec.SpecFeralCatDruid` is the DPS
 * feral spec (`proto/common.ts`) — `Spec.SpecFeralBearDruid` (tank) is a
 * different `DetectedSpecId` value the engine never produces here (see
 * engine/types.ts's doc comment on `DetectedSpecId`).
 */
/**
 * Content-filter value meaning "no filter".
 *
 * Deliberately outside the filter's own value space. Every real option
 * comes from `raidFilterGroups`, which returns a zone name or a
 * `SOURCE_LABELS` bucket -- never the empty string. A sentinel
 * inside the value space, such as the earlier `all`, would silently mean
 * "no filter" for a zone or bucket that happened to be named that way.
 */
const NO_RAID_FILTER = '';

/**
 * Which proto spec the engine can rank, and under what name.
 *
 * Stays `Partial` on purpose. The proto enum covers tanks and healers this
 * engine has no universe for, so a spec absent from this map is a real state
 * the tab must render — the `unsupported-spec` message — rather than a gap to
 * be filled. What changed with the all-DPS-specs pass is only which specs are
 * present: all eleven DPS ones, where before it was two.
 */
const SPEC_ID_BY_PROTO_SPEC: Partial<Record<Spec, SpecId>> = {
	[Spec.SpecBalanceDruid]: 'balance',
	[Spec.SpecFeralCatDruid]: 'feral',
	[Spec.SpecHunter]: 'hunter',
	[Spec.SpecMage]: 'mage',
	[Spec.SpecRetributionPaladin]: 'ret',
	// The fork ships exactly one DPS priest sim and it registers SpecPriest
	// with a shadow config (ui/priest/dps/sim.ts). There is no separate
	// shadow value in the enum.
	[Spec.SpecPriest]: 'shadow',
	[Spec.SpecRogue]: 'rogue',
	[Spec.SpecElementalShaman]: 'ele',
	[Spec.SpecEnhancementShaman]: 'enh',
	[Spec.SpecWarlock]: 'warlock',
	[Spec.SpecDpsWarrior]: 'warrior',
};

/**
 * Sub-tab identity for the slot strip. `'shopping-list'` is the always-first
 * tab (plan §4's sub-tab 1); everything else is one `SimOrderName` per
 * populated slot.
 *
 * `'offhand'` is included, and needs no special casing: the strip is derived
 * from the slots the ranked rows actually occupy (`slotsInView`), so it
 * appears for a dual-wielding spec and stays absent for every other one. The
 * comment here used to say offhand was excluded because no pool slot mapped
 * onto it; `simSlotsForPoolSlot` now maps `"weapon"` onto both hands for the
 * four dual-wield specs.
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

/**
 * One view-controls checkbox, built on the site's native `BooleanPicker`
 * (`inline: true`) so it carries the `.form-check` markup by construction
 * rather than by the hand-rolled `<label><input>` this class used to hold
 * (ticket 334). The two-state value lives in `this.value`, driven through the
 * picker's `getValue`/`setValue` triad; the picker's own `change` listener
 * calls `setValue`, which runs `onChange` (the tab's `render`), so no manual
 * `change` listener is wired outside the class.
 *
 * `setVisible` only shows and hides. It deliberately does **not** force the
 * box off while hidden, which is what the prune control's old bespoke
 * visibility method did: forcing it off destroys the user's preference the
 * moment a spec or phase change hides the control, and silently restores an
 * unchecked box when it comes back. The safety that force-off bought — a
 * hidden prune must not apply to the next run — is bought instead by gating
 * at the *read* site (`pruneEffective()`: `visible && checked`), which keeps
 * the preference. Hiding toggles `.d-none` on the picker's `rootElem` and
 * never touches `this.value`, so the property holds by construction.
 *
 * That read-site gate is for the **prune control only**. The set-potential
 * and BiS-only controls feed the done-state view's sort key, and gating them
 * on visibility would move the order the Q1 measurement was taken against, so
 * those two keep reading `checked` directly.
 *
 * The two-state choice lives **inside this class only**: `checked: boolean` is
 * the entire external surface (three read sites, two visibility drivers, one
 * `setText`), exactly as it was before the swap. The set-potential control is
 * expected to become a three-state control later (weighted set-bonus variant);
 * that variant re-implements the internal `BooleanPicker` over an `EnumPicker`
 * (the same `Input` base, the same `getValue`/`setValue` triad) behind this
 * same surface, so no consumer outside the class bakes in two-state semantics.
 */
class ViewToggle {
	private value = false;
	private readonly emitter = new TypedEvent<void>();
	private readonly picker: BooleanPicker<ViewToggle>;
	private readonly qualifierElem?: HTMLElement;

	constructor(
		host: HTMLElement,
		config: {
			id: string;
			label: string;
			labelTooltip?: string;
			qualifier?: boolean;
			extraCssClasses?: Array<string>;
			onChange: () => void;
		},
	) {
		this.picker = new BooleanPicker<ViewToggle>(host, this, {
			id: config.id,
			label: config.label,
			labelTooltip: config.labelTooltip,
			extraCssClasses: config.extraCssClasses,
			inline: true,
			changedEvent: () => this.emitter,
			getValue: () => this.value,
			setValue: (_eventID, _obj, newValue) => {
				this.value = newValue;
				config.onChange();
			},
		});
		// The picker appends its root INTO the host; toggle `.d-none` on that
		// root (not the host) so the class carrying the `.form-check` layout is
		// the same one visibility acts on.
		this.picker.rootElem.classList.add('d-none');
		if (config.qualifier) {
			const label = this.picker.rootElem.querySelector('label');
			this.qualifierElem = (<small className="upgrades-view-qualifier" />) as HTMLElement;
			label?.appendChild(this.qualifierElem);
		}
	}

	/** The picker root, so callers (SCSS-facing) can tag it for styling. */
	get rootElem(): HTMLElement {
		return this.picker.rootElem;
	}

	get checked(): boolean {
		return this.value;
	}

	get visible(): boolean {
		return !this.picker.rootElem.classList.contains('d-none');
	}

	setVisible(visible: boolean): void {
		setControlVisible(this.picker.rootElem, visible);
	}

	setText(text: string): void {
		if (this.qualifierElem) this.qualifierElem.textContent = text;
	}
}

/**
 * The visibility half of `ViewToggle`, as a free function so the raid filter
 * can share it. That control is a `<select>` populated by `replaceChildren`
 * with value preservation, not a checkbox — it has no `checked` to own, so it
 * borrows visibility and nothing else. `ViewToggle` passes its picker root
 * here; the raid filter passes its `<label>`.
 */
function setControlVisible(elem: HTMLElement, visible: boolean): void {
	elem.classList.toggle('d-none', !visible);
}

/**
 * "Is this entry on a BIS list?" — the one spelling of the test the prune
 * filter, the prune-availability check, the BiS-only view filter and the
 * `pinBis` hoist all used to write out by hand. Pool entries carry `bisTags`
 * optionally; ranked rows always carry it, so the optional shape covers both.
 */
function isBisTagged(entry: { bisTags?: readonly string[] }): boolean {
	return (entry.bisTags?.length ?? 0) > 0;
}

/**
 * A delta in the results tables, with its unit: "+104.9 DPS".
 *
 * Both renderers used to hardcode the `+`, so a negative delta rendered as
 * "+-41.0" — mid-run rows are frequently negative, so this was on screen. The
 * sign comes from the number.
 *
 * The unit goes through i18n rather than being appended here, because where a
 * unit sits relative to its number is language-dependent, and because every
 * other "DPS" this page renders is already a locale string — `status.done`
 * spells the same figure "{{dps}} DPS".
 */
function formatDelta(deltaDps: number): string {
	const sign = deltaDps > 0 ? '+' : '';
	return i18n.t('upgrades_tab.results.delta_dps_value', { delta: `${sign}${deltaDps.toFixed(1)}` });
}

/**
 * Trims a substitution detail to its first line for display (ticket 311).
 *
 * A substitution caused by a sim crash carries the whole Go stack trace in its
 * detail — thousands of bytes of goroutine frames — and the first line of the
 * error already says what went wrong. The trace's newlines arrive both as real
 * newline characters and as written-out backslash-n pairs, because the sim's
 * error object is stringified into the detail, so both count as a line break.
 *
 * Deliberate drift: this mirrors `firstLineOf` in
 * `packages/core/src/rank-report.ts:154`, which cannot be imported — nothing in
 * `packages/core` is reachable from the fork's `ui/`, and the engine port
 * directory is byte-gated. The suffix differs on purpose: the report path points
 * at its JSON artifact, and this tab has none, so it points at the console where
 * `substitutionsContent` logs the full detail instead.
 */
function firstLineOf(detail: string): string {
	const line = detail.split(/\r?\n|\\n/, 1)[0] ?? detail;
	return line === detail ? detail : `${line}${i18n.t('upgrades_tab.assumptions.substitution_truncated_suffix')}`;
}

/**
 * Column identity for the sortable columns in both results-table heads
 * (ticket 280, ticket 289, ticket 287 follow-through). One id per `<th>`,
 * in table order *after* the fixed Rank column — `resultsTableHead` and
 * `sortableResultsTableHead` both render Rank first, then these, so the
 * on-screen column order is `[rank, ...RESULTS_SORT_COLUMNS]`. `rank` is
 * deliberately absent here: the cell is a display position, never a value
 * to sort by (`rankColumnLabel`, `resultsSortKey`). The mobile SCSS's
 * `nth-child` column-width rules depend on the total column count (five)
 * and this order staying put, so a new column would need matching
 * `nth-child` rules in `_upgrades_tab.scss`.
 */
const RESULTS_SORT_COLUMNS = ['item', 'slot', 'delta_dps', 'source'] as const;
type ResultsSortColumn = (typeof RESULTS_SORT_COLUMNS)[number];

/**
 * The Rank column's header label. Not part of `RESULTS_SORT_COLUMNS`: the
 * cell shows a row's position in its own table's current display order (not
 * `RankedItem.rank`), so sorting by it would be a tautology — there is
 * nothing to click. Both table heads render it as the same fixed first
 * column, ahead of the sortable columns.
 */
function rankColumnLabel(): string {
	return i18n.t('upgrades_tab.results.rank');
}

/**
 * The results table header. Both this and `sortableResultsTableHead` render
 * the Rank column plus `RESULTS_SORT_COLUMNS` so the mid-run table and the
 * done-state tables cannot drift into different column sets, which is how
 * the mid-run table ended up four columns wide with no Rank (ticket 278),
 * and how a sortable variant reintroduced that same drift risk (ticket 289).
 *
 * Plain, non-interactive header for tables with no stable row set to sort —
 * the mid-run skeleton fill and the Stop-truncated result render straight
 * from `ranking.items` in landing/delta order, not through `applyView`
 * (ticket 280 scope is the done-state tables; see `sortableResultsTableHead`
 * for those).
 */
function resultsTableHead(): Node {
	return (
		<thead>
			<tr>
				<th>{rankColumnLabel()}</th>
				{RESULTS_SORT_COLUMNS.map(column => (
					<th>{resultsSortColumnLabel(column)}</th>
				))}
			</tr>
		</thead>
	);
}

type ResultsSort = { column: ResultsSortColumn; direction: 'asc' | 'desc' };

/**
 * The i18n label already used for each column header, reused as the click
 * target rather than a second copy of the same string.
 */
function resultsSortColumnLabel(column: ResultsSortColumn): string {
	return i18n.t(`upgrades_tab.results.${column}`);
}

/**
 * Sort-key extraction for each column, applied to the done-state `ViewRow`
 * shape. Every column sorts on the same text/number a reader sees in that
 * cell. The Rank column carries no key of its own — it is a display
 * position, not a value to sort by (see `RESULTS_SORT_COLUMNS`).
 */
function resultsSortKey(column: ResultsSortColumn, row: ViewRow): string | number {
	switch (column) {
		case 'item':
			return row.name.toLowerCase();
		case 'slot':
			return slotLabel(effectiveSlot(row)).toLowerCase();
		case 'delta_dps':
			return row.deltaDps;
		case 'source':
			return sourceLabel(row.source).toLowerCase();
	}
}

/**
 * Orders `rows` by `sort`, stable on the engine's own order for equal keys
 * (`Array.prototype.sort` is stable, and `rows` arrives already ordered by
 * `applyView`'s `compareRows`) so a sort that does not distinguish two rows
 * never reshuffles them arbitrarily.
 *
 * The Rank column is not sortable (see `RESULTS_SORT_COLUMNS`) and always
 * shows each row's 1-based position in the order this function returns, so
 * sorting by another column renumbers Rank rather than leaving it fixed.
 */
function sortRows(rows: readonly ViewRow[], sort: ResultsSort): ViewRow[] {
	const dir = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const ak = resultsSortKey(sort.column, a);
		const bk = resultsSortKey(sort.column, b);
		if (ak === bk) return 0;
		return ak < bk ? -dir : dir;
	});
}

export class UpgradesTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	protected shoppingListElem: HTMLElement;
	protected settingsCardElem: HTMLElement;
	protected viewControlsHostElem: HTMLElement;
	protected eligibleCountElem!: HTMLElement;

	// The run settings the pickers write through to. They are tab state, not
	// `Sim` state: `Input` carries no `Sim`/`Player` constraint, and the Batch
	// tab already binds its pickers to plain component fields through a bare
	// emitter (`bulk_tab.tsx:47`). The Phase selector is the deliberate
	// exception -- it stays `makePhaseSelector`, because it surfaces the page's
	// shared phase rather than anything this tab owns.
	//
	// A picker writes on change, but the run must still use the values as of
	// the Run click, so `run()` reads these fields (and re-derives the cap
	// through `readCandidateCap()`) at click time exactly as it read the input
	// elements before.
	readonly settingsChangedEmitter = new TypedEvent<void>();
	private iterations: number = DEFAULT_ITERATIONS;
	/** 0 means "no cap" -- the picker renders it as an empty field (`showZeroes: false`). */
	private candidateCap = 0;
	private bisPrune = false;

	protected runButton!: HTMLButtonElement;
	protected stopButton!: HTMLButtonElement;
	/** The prune picker's root, so visibility can be toggled without reaching into the picker. */
	protected bisPruneElem!: HTMLElement;
	/** The candidates picker's root, so its placeholder can be kept current. */
	protected candidatesPickerElem!: HTMLElement;
	protected setPotentialControl!: ViewToggle;
	protected bisOnlyControl!: ViewToggle;
	protected raidFilterSelect!: HTMLSelectElement;
	protected raidFilterLabel!: HTMLElement;
	// Tracks the user's choice independent of the DOM: `refreshRaidFilter()`
	// rebuilds `raidFilterSelect` (including a full clear while non-'done')
	// on every render, and rebuilding a <select> resets `.value` to `""`.
	// Reading the field back, rather than the element, is what lets the
	// selection survive the hundreds of clear-and-rebuild cycles a run's
	// row-landed progress callbacks trigger before the state reaches 'done'.
	private pendingRaidFilter: string = NO_RAID_FILTER;
	protected statusElem!: HTMLElement;
	/** Last kind written to a live region, so a re-render within one state stays silent. */
	private announcedKind: RunState['kind'] | undefined;
	protected statusAnnounceElem!: HTMLElement;
	protected errorAlertElem!: HTMLElement;
	protected resultsElem!: HTMLElement;
	protected substitutionsHostElem!: HTMLElement;
	protected exportBoxElem!: HTMLElement;
	protected exportAreaElem!: HTMLTextAreaElement;
	protected exportCountElem!: HTMLElement;
	protected exportFlavourCaptionElem!: HTMLElement;
	// Which id each tier row emits (ticket 126). ThatsMyBis tracks what actually
	// drops in the raid — a class token, not the tier piece — so the token
	// flavour is the default and the reason this export exists. The gear-id
	// flavour is kept for the wowsims-shaped importer, and the caption names
	// whichever is active. Off = gear ids, on = token ids.
	private exportTokenFlavour = true;

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
	// The factory answers for the WASM transport only, because it is the only
	// answer available synchronously. Under the packaged local Go server the
	// right runner is `BulkHttpSimRunner` instead, and which transport this page
	// actually has is only knowable once a worker reports ready
	// (`worker_pool.ts:315`) — the serving server decides it, by rewriting
	// `sim_worker.js` to `net_worker.js` (`sim/web/main.go:402-403`), so no
	// synchronous check can see it. Hence `simRunner()` below: this field is the
	// WASM-side answer and the fallback, resolved or replaced on first use.
	//
	// It is called with bulk screening OFF, so this runner has no
	// `runBulkScreen` and `rankUpgrades` takes its per-candidate path unchanged.
	// Bulk screening is an HTTP-transport capability: the in-browser tournament
	// prices a whole 25-candidate chunk (332 s measured) before the first row
	// lands, against 9.35 s per chunk on the Go server. `makeSimRunner`'s header
	// carries the measurements and names ticket 346 as the revisit trigger.
	private readonly sim = makeSimRunner();
	// Memoised so the transport is probed once per tab, not once per run, and so
	// two runs never hold different runners (each runner owns worker pools).
	private simRunnerPromise: Promise<WasmSimRunner | BulkHttpSimRunner> | undefined;
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
	// Wall-clock of the last finished run, in seconds. Held on the instance
	// rather than in the 'done'/'stopped' state so a re-render triggered by a
	// view control (which runs no sims) keeps showing the run's own elapsed
	// instead of clearing it. `undefined` until a run finishes.
	private lastRunSeconds: number | undefined;
	// Whether the run that produced the current result was pruned to BIS-list
	// items. Captured at run time, not read from the checkbox at render time:
	// the drawer has to describe the run the numbers came from, and the box can
	// be toggled afterwards.
	private lastRunPruned = false;

	// Column-header sort state for the done-state results tables (ticket 280).
	// `undefined` means "the engine's own order" (rank ascending / delta
	// descending, `view.ts`'s `compareRows`) -- a display concern held on the
	// instance like the view-option checkboxes, not part of `ViewOptions`:
	// sorting never re-runs `applyView` or changes which rows are in the
	// shortlist vs. below-cutoff, only the order the survivors render in.
	// Shared across the shopping list and every slot pane, matching how
	// `bisOnlyControl`/`setPotentialControl` are one switch for every pane
	// rather than per-pane state.
	private resultsSort: ResultsSort | undefined;

	constructor(parentElem: HTMLElement, simUI: IndividualSimUI<any>) {
		super(parentElem, simUI, { identifier: 'upgrades-tab', title: i18n.t('upgrades_tab.title') });

		this.simUI = simUI;

		const shoppingListBtnRef = ref<HTMLButtonElement>();
		const shoppingListRef = ref<HTMLDivElement>();
		const tabNavRef = ref<HTMLUListElement>();
		const tabContentRef = ref<HTMLDivElement>();
		const settingsCardRef = ref<HTMLDivElement>();
		const viewControlsHostRef = ref<HTMLDivElement>();

		this.contentContainer.appendChild(
			<>
				<div className="upgrades-tab-left tab-panel-left">
					{/*
					 * The post-run filters sit here -- a direct child of the left
					 * panel, before the sub-tab area -- rather than inside the
					 * shopping-list pane, so they are visible and effective on
					 * whichever sub-tab is showing. Inside the pane they governed
					 * rows the reader could not see them from, which is how the
					 * owner came to look for the BiS-only toggle and conclude it did
					 * not exist (ticket 312).
					 */}
					<div ref={viewControlsHostRef} className="upgrades-view-controls-host" />
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
				{/*
				 * The run settings live in their own panel, outside the sub-tab
				 * panes, so Run stays on screen whichever sub-tab is active -- it
				 * used to be inside the shopping-list pane and vanished the moment a
				 * slot sub-tab was selected (ticket 312). The two-pane split and the
				 * sticky card are the Batch tab's own structure (`bulk_tab.tsx:155`,
				 * `_bulk_tab.scss:11-23`), borrowed rather than invented.
				 */}
				<div className="upgrades-tab-right tab-panel-right">
					<div className="upgrades-settings-outer-container">
						<div ref={settingsCardRef} className="upgrades-settings-container" />
					</div>
				</div>
			</>,
		);

		this.shoppingListElem = shoppingListRef.value!;
		this.settingsCardElem = settingsCardRef.value!;
		this.viewControlsHostElem = viewControlsHostRef.value!;
		this.tabNavElem = tabNavRef.value!;
		this.tabContentElem = tabContentRef.value!;
		this.paneContentElems.set('shopping-list', document.createElement('div'));

		new Tab(shoppingListBtnRef.value!);
		this.tabNavElem.addEventListener('shown.bs.tab', e => {
			const target = (e.target as HTMLElement).dataset.bsTarget;
			const found = ([...this.paneContentElems.keys()] as SubTabId[]).find(id => paneId(id) === target?.slice(1));
			if (found) this.activeSubTab = found;
		});

		this.buildTabContent();
		this.wireStalenessListeners();
	}

	protected buildTabContent() {
		const eligibleCountRef = ref<HTMLParagraphElement>();
		const runButtonRef = ref<HTMLButtonElement>();
		const stopButtonRef = ref<HTMLButtonElement>();
		const iterationsPickerRef = ref<HTMLDivElement>();
		const candidatesPickerRef = ref<HTMLDivElement>();
		const bisPrunePickerRef = ref<HTMLDivElement>();
		const settingsToggleRef = ref<HTMLButtonElement>();
		const settingsBodyRef = ref<HTMLDivElement>();
		const setPotentialPickerRef = ref<HTMLDivElement>();
		const bisOnlyPickerRef = ref<HTMLDivElement>();
		const raidFilterSelectRef = ref<HTMLSelectElement>();
		const raidFilterLabelRef = ref<HTMLLabelElement>();
		const phaseSelectorRef = ref<HTMLDivElement>();
		const statusRef = ref<HTMLDivElement>();
		const statusAnnounceRef = ref<HTMLDivElement>();
		const errorAlertRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();
		const substitutionsHostRef = ref<HTMLDivElement>();
		const exportBoxRef = ref<HTMLDivElement>();
		const exportAreaRef = ref<HTMLTextAreaElement>();
		const exportCountRef = ref<HTMLSpanElement>();
		const exportCopyHostRef = ref<HTMLSpanElement>();
		const exportFlavourToggleRef = ref<HTMLInputElement>();
		const exportFlavourCaptionRef = ref<HTMLParagraphElement>();

		this.settingsCardElem.appendChild(
			<div className="upgrades-run-controls">
				{/*
				 * Readout first, then the action it gates, then the knobs that rarely
				 * change -- the Batch tab's own internal order
				 * (`bulk_tab.tsx:158-161`). Stacking them as rows instead of wrapping
				 * them into one line is what lets the BiS-prune label wrap normally
				 * rather than being the widest thing on the row (ticket 312).
				 */}
				<p ref={eligibleCountRef} className="upgrades-eligible-count h4" />
				<button ref={runButtonRef} className="btn btn-primary upgrades-run-button" type="button">
					{i18n.t('upgrades_tab.run')}
				</button>
				<div className="upgrades-secondary-actions">
					<button ref={stopButtonRef} className="btn btn-outline-danger upgrades-stop-button" type="button" disabled>
						{i18n.t('upgrades_tab.stop')}
					</button>
				</div>
				{/*
				 * The four set-once knobs, in a native disclosure. Below `xl` the
				 * shared `.tab-pane-content-container` stacks the panels into one
				 * column, and these four rows are 208px of controls a phone reader
				 * scrolls past every time to reach anything else -- so there they
				 * collapse behind the summary, closed on first paint (ticket 321).
				 * Run, Stop and the eligible count are deliberately outside it and
				 * never collapse.
				 *
				 * A button plus a class, deliberately NOT a `<details>`. `<details>`
				 * was tried first and measured broken: a closed `<details>` hides its
				 * own non-summary children as a UA behaviour that neither
				 * `display: contents` on the element nor on the body defeats, so at
				 * 1280px all four controls reported `checkVisibility() === false`
				 * while every gate exited 0. Desktop must ignore the collapsed state
				 * entirely, and only an ordinary class the SCSS can override at `xl`
				 * gives that. `aria-expanded` carries the state for AT.
				 *
				 * Mount points only. The controls themselves are real pickers, built
				 * below -- the same `NumberPicker`/`BooleanPicker` rows the Batch
				 * and Settings tabs use, rather than markup imitating them
				 * (ticket 312). Borrowing the real component is what gives the
				 * prune label its normal wrapping and the number fields their
				 * content-driven width.
				 */}
				<div className="upgrades-run-settings">
					<button ref={settingsToggleRef} className="upgrades-run-settings-summary" type="button" attributes={{ 'aria-expanded': 'false' }}>
						{i18n.t('upgrades_tab.settings_title')}
					</button>
					<div ref={settingsBodyRef} className="upgrades-run-settings-body">
						<div ref={iterationsPickerRef} className="upgrades-iterations-picker" />
						<div ref={candidatesPickerRef} className="upgrades-candidates-picker" />
						<div ref={bisPrunePickerRef} className="upgrades-bis-prune-picker d-none" />
						{/* Not a <label>: the picker self-names through its options, so the
						    wrapper exists only to give the selector the same treatment
						    the other run inputs get from their label elements. */}
						<div className="upgrades-phase-label">
							<div ref={phaseSelectorRef} className="upgrades-phase-selector" />
						</div>
					</div>
				</div>
			</div>,
		);

		this.viewControlsHostElem.appendChild(
			<div className="upgrades-view-controls">
				{/*
				 * Named as what it does to rows already computed, so the row cannot
				 * be read as more run settings -- the confusion that made the owner
				 * miss the BiS-only toggle. `.content-block-header` is the site's
				 * own labelled-subgroup idiom, borrowed rather than invented.
				 */}
				<span className="content-block-header upgrades-view-controls-title">{i18n.t('upgrades_tab.view.title')}</span>
				<div className="upgrades-view-controls-group">
					{/*
					 * Mount points only. The controls are native `BooleanPicker`s
					 * (`inline: true`) built below (ticket 334): the picker owns the
					 * `.form-check` markup — a `<label class="form-label">` sibling to
					 * the checkbox — so the view row carries the same native shape the
					 * other picker rows do rather than hand-rolled label markup. For
					 * BiS only, "BiS only" is the control's name and the phase it lists
					 * against is a qualifier, not part of the name; `ViewToggle`
					 * appends the qualifier `<small>` into the picker's `form-label`
					 * so it follows the name in smaller secondary text (ticket 312),
					 * inside the click/hover target the label's `htmlFor` toggles.
					 */}
					<div ref={setPotentialPickerRef} />
					<div ref={bisOnlyPickerRef} />
					<label ref={raidFilterLabelRef} className="upgrades-raid-filter-label d-none">
						{i18n.t('upgrades_tab.view.raid_filter')}
						<select ref={raidFilterSelectRef} className="upgrades-raid-filter form-select" />
					</label>
				</div>
			</div>,
		);

		this.shoppingListElem.appendChild(
			<div className="upgrades-shopping-list p-gap content-block">
				{/*
				 * The visible status text. Not itself a live region: it holds the
				 * per-tick running text, which changes about once a second for up to
				 * a minute and a half, and announcing every tick is worse than
				 * announcing none. The progress bar rendered inside it carries the
				 * numbers for AT through its own `role="progressbar"`, which is the
				 * surface built for a value that changes continuously.
				 */}
				<div ref={statusRef} className="upgrades-status" />
				{/*
				 * The announcement channel, kept separate from the visible text so
				 * the two can differ: this speaks only at state *transitions*, never
				 * on a running tick. Both elements are permanent -- a live region
				 * must already be in the DOM before its content changes, or the
				 * change is not announced at all -- and `render()` only ever calls
				 * `replaceChildren` on them.
				 *
				 * Two regions because the two urgencies differ. Polite for ordinary
				 * transitions; `role="alert"` is assertive and interrupts, which is
				 * right for a failure and wrong for finishing a run. Switching one
				 * element's role at announce time does not work -- the role has to be
				 * there before the content arrives. The alert carries no explicit
				 * `aria-live`: pairing the two makes VoiceOver on iOS speak twice.
				 */}
				<div
					ref={statusAnnounceRef}
					className="upgrades-status-announce visually-hidden"
					attributes={{ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }}
				/>
				<div ref={errorAlertRef} className="upgrades-status-alert visually-hidden" attributes={{ role: 'alert' }} />
				{/*
				 * The block rhythm comes from `.content-block`'s own `gap`
				 * (`--block-spacer`) on the wrapper, not from per-element `mt-gap`
				 * utilities: the spacing between the toolbar, status, results and
				 * substitutions is one decision made once, so a state that renders
				 * nothing collapses its slot instead of leaving a stranded margin.
				 */}
				<div ref={resultsRef} className="upgrades-results" />
				{/*
				 * The ThatsMyBis export (ticket 314), with the results rather than
				 * with the run settings: it exports what is displayed, so it belongs
				 * next to the rows it mirrors and follows the same reasoning that
				 * puts the view filters above them. Permanent in the DOM and hidden
				 * until a run produces rows, like the other post-run surfaces.
				 */}
				<div ref={exportBoxRef} className="upgrades-export content-block d-none">
					<span className="content-block-header">{i18n.t('upgrades_tab.export.title')}</span>
					<p className="upgrades-export-caveat">{i18n.t('upgrades_tab.export.caveat')}</p>
					{/*
					 * Which id each tier row emits (ticket 126). ThatsMyBis tracks
					 * what actually drops in the raid — the class token, not the
					 * tier piece — so this defaults on and the caption below names
					 * the active flavour. Off falls back to the wowsims-shaped gear
					 * ids. A plain checkbox rather than a ViewToggle: it changes the
					 * export FORMAT, not the ranking or which rows show.
					 */}
					<label className="upgrades-export-flavour">
						<input ref={exportFlavourToggleRef} type="checkbox" checked={this.exportTokenFlavour} />
						{i18n.t('upgrades_tab.export.flavour_toggle')}
					</label>
					<p ref={exportFlavourCaptionRef} className="upgrades-export-flavour-caption" />
					<textarea ref={exportAreaRef} className="upgrades-export-area form-control" rows={6} />
					<div className="upgrades-export-actions">
						<span ref={exportCountRef} className="upgrades-export-count" />
						{/*
						 * The native CopyButton (ticket 328): a filled `btn-secondary`
						 * with the `fas fa-copy` icon and the site's own copied-state
						 * feedback, mounted into this host. Replaces the hand-rolled
						 * transparent outline button the owner read as disabled.
						 */}
						<span ref={exportCopyHostRef} className="upgrades-export-copy-host" />
					</div>
				</div>
				<div ref={substitutionsHostRef} className="upgrades-substitutions-host" />
			</div>,
		);

		this.eligibleCountElem = eligibleCountRef.value!;
		this.runButton = runButtonRef.value!;
		this.stopButton = stopButtonRef.value!;
		// A view option, not a run input: `onChange` re-renders, applying the
		// toggle to the ranking already in hand and dispatching no sim. The
		// picker's own `change` listener carries this through `setValue`, so no
		// manual `change` listener is wired below.
		//
		// The set-potential toggle needs an explanation of what it does to the
		// ranking (ticket 328 item 4). `labelTooltip` attaches the site's tippy to
		// the picker's `<label>` — the same label-element hover target the old
		// hand-attached tippy used.
		this.setPotentialControl = new ViewToggle(setPotentialPickerRef.value!, {
			id: 'upgrades-set-potential',
			label: i18n.t('upgrades_tab.view.set_potential'),
			labelTooltip: i18n.t('upgrades_tab.view.set_potential_tooltip'),
			extraCssClasses: ['upgrades-set-potential-control'],
			onChange: () => this.render(),
		});
		this.bisOnlyControl = new ViewToggle(bisOnlyPickerRef.value!, {
			id: 'upgrades-bis-only',
			label: i18n.t('upgrades_tab.view.only_bis'),
			qualifier: true,
			extraCssClasses: ['upgrades-bis-only-control'],
			onChange: () => this.render(),
		});
		this.bisPruneElem = bisPrunePickerRef.value!;
		this.candidatesPickerElem = candidatesPickerRef.value!;
		this.raidFilterSelect = raidFilterSelectRef.value!;
		this.raidFilterLabel = raidFilterLabelRef.value!;
		this.statusElem = statusRef.value!;
		this.statusAnnounceElem = statusAnnounceRef.value!;
		this.errorAlertElem = errorAlertRef.value!;
		this.resultsElem = resultsRef.value!;
		this.substitutionsHostElem = substitutionsHostRef.value!;
		this.exportBoxElem = exportBoxRef.value!;
		this.exportAreaElem = exportAreaRef.value!;
		// The payload is generated, never typed into; set as a property because
		// the JSX `attributes` map does not carry `readonly`.
		this.exportAreaElem.readOnly = true;
		this.exportCountElem = exportCountRef.value!;
		this.exportFlavourCaptionElem = exportFlavourCaptionRef.value!;

		// The token/gear-id flavour toggle (ticket 126). A change re-renders,
		// which recomputes the payload through `updateExport` with the new
		// flavour and repaints the caption — the same render-on-change pattern
		// the view toggles use, but this one touches only the export format.
		exportFlavourToggleRef.value!.addEventListener('change', (ev) => {
			this.exportTokenFlavour = (ev.currentTarget as HTMLInputElement).checked;
			this.render();
		});

		// The site's own copy control (ticket 328): filled `btn-secondary`, the
		// `fas fa-copy` icon, and the shared copied-state feedback, in place of
		// the hand-rolled transparent button. `getContent` reads the current
		// export payload at click time, matching the old handler. CopyButton
		// carries wowsims' own insecure-origin behaviour (an `alert` of the
		// payload) rather than this tab's former select-and-copy fallback -- the
		// deliberate cost of adopting the native component.
		new CopyButton(exportCopyHostRef.value!, {
			getContent: () => this.exportAreaElem.value,
			extraCssClasses: ['btn-secondary', 'upgrades-export-copy'],
			text: i18n.t('upgrades_tab.export.copy'),
		});
		this.paneContentElems.set('shopping-list', this.resultsElem);

		// The page's own phase picker, bound to the same `sim` the Gear tab's
		// item-selector modal binds it to. Surfacing the setting, not
		// overriding it: a tab-local phase could silently disagree with the
		// page's, and the pool this tab ranks is chosen by exactly this value.
		makePhaseSelector(phaseSelectorRef.value!, this.simUI.sim);

		// The three run inputs, as the pickers the rest of the site uses. Each
		// binds to a tab field through `settingsChangedEmitter` -- a bare
		// `TypedEvent<void>`, exactly as the Batch tab binds its own pickers to
		// plain component state (`bulk_tab.tsx:47, 693-701`).
		//
		// Each `setValue` emits `settingsChangedEmitter`, matching the Batch
		// tab's setters (`bulk_tab.tsx:596, 638, 658, 664`). The emit is what
		// makes the `Input` base's re-sync path (`input.tsx:68`) live: on the
		// event every bound picker repaints from its source field, so a
		// *programmatic* write to a field shows through instead of leaving a
		// stale display. For a user edit the repaint is a no-op (the field
		// already holds what the picker just wrote).
		//
		// Writing on change does not change *when* a run reads them: `run()`
		// still calls `readIterations()` and `readCandidateCap()` at click time,
		// which now read these fields. Editing a picker mid-run cannot alter the
		// run in flight, same as editing the old inputs could not.
		new NumberPicker<UpgradesTab>(iterationsPickerRef.value!, this, {
			id: 'upgrades-iterations',
			label: i18n.t('upgrades_tab.iterations_label'),
			positive: true,
			changedEvent: _ => this.settingsChangedEmitter,
			getValue: _ => this.iterations,
			setValue: (eventID, _obj, newValue: number) => {
				this.iterations = newValue;
				this.settingsChangedEmitter.emit(eventID);
			},
		});

		// Zero renders as an empty field and means "no cap" -- the same meaning
		// the old empty input carried, and the meaning `RankInput.candidateCap`
		// gives `undefined` (candidate-pool.md §5.1.1).
		new NumberPicker<UpgradesTab>(candidatesPickerRef.value!, this, {
			id: 'upgrades-candidates',
			label: i18n.t('upgrades_tab.candidates_label'),
			positive: true,
			showZeroes: false,
			changedEvent: _ => this.settingsChangedEmitter,
			getValue: _ => this.candidateCap,
			setValue: (eventID, _obj, newValue: number) => {
				this.candidateCap = newValue;
				this.settingsChangedEmitter.emit(eventID);
			},
		});

		// The label that used to be the widest thing on the toolbar row. As a
		// picker row in the card it wraps normally instead (ticket 312).
		new BooleanPicker<UpgradesTab>(bisPrunePickerRef.value!, this, {
			id: 'upgrades-bis-prune',
			label: i18n.t('upgrades_tab.prune.only_bis', { phase: i18n.t(`common.phases.${this.simUI.sim.getPhase()}`) }),
			inline: true,
			changedEvent: _ => this.settingsChangedEmitter,
			getValue: _ => this.bisPrune,
			setValue: (eventID, _obj, newValue: boolean) => {
				this.bisPrune = newValue;
				this.refreshCandidatesPlaceholder();
				this.settingsChangedEmitter.emit(eventID);
			},
		});

		this.runButton.addEventListener('click', () => {
			this.run().catch(err => {
				this.setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
			});
		});

		// The two view toggles re-render on change through their picker's own
		// `setValue` (`onChange: () => this.render()` at construction), so no
		// manual `change` listener is wired for them here.
		this.raidFilterSelect.addEventListener('change', () => {
			this.pendingRaidFilter = this.raidFilterSelect.value;
			this.render();
		});
		// The prune control is a run input, not a view option: it changes what the
		// *next* run sims, so it refreshes the count the placeholder promises and
		// nothing else. That refresh now happens in the picker's own `setValue`,
		// so there is no separate change listener for it.

		// Stop's contract (candidate-pool.md §5.1.4) is "finish in-flight
		// per-candidate sims, abort an in-flight screening chunk, dispatch
		// nothing new" — signalling the abort is all this button does;
		// rankUpgrades itself decides what "in-flight" means and returns the
		// PartialRanking, so there is nothing else for the click handler to do.
		// The screening chunk is the exception because it is not a sim but a
		// batch of them: seconds on the Go transport, minutes in the browser
		// (ticket 347).
		this.stopButton.addEventListener('click', () => {
			this.abortController?.abort();
		});

		// The collapse is only ever a narrow-width affordance: at `xl` and up the
		// SCSS shows the body unconditionally and hides this button, so the class
		// toggled here is inert there and desktop cannot be left holding a
		// collapsed card. Nothing reads the state back -- the pickers own their
		// own values, and the Run handler still derives the candidate cap at
		// click time regardless of whether the group is showing.
		settingsToggleRef.value!.addEventListener('click', () => {
			const expanded = settingsBodyRef.value!.classList.toggle('upgrades-run-settings-body--open');
			settingsToggleRef.value!.setAttribute('aria-expanded', String(expanded));
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
		this.refreshPhaseLabels();
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		if (!specId) {
			setControlVisible(this.bisPruneElem, false);
			this.setCandidatesPlaceholder(i18n.t('upgrades_tab.candidates_placeholder_uncapped'));
			this.eligibleCountElem.textContent = i18n.t('upgrades_tab.eligible_count_unknown');
			return;
		}
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		// Availability is decided on the unpruned pool: asking whether the
		// pruned pool has tags would be circular once the toggle is on.
		setControlVisible(this.bisPruneElem, poolFor(specId, maxPhase).some(isBisTagged));
		const eligible = this.eligibleCount(specId, maxPhase);
		this.setCandidatesPlaceholder(i18n.t('upgrades_tab.candidates_placeholder', { count: eligible }));
		// The count the Run button acts on, sitting with it in the card -- the
		// Batch tab's readout-above-the-action idiom (`bulk_tab.tsx:158`).
		this.eligibleCountElem.textContent = i18n.t('upgrades_tab.eligible_count', { count: eligible });
	}

	/**
	 * The Candidates picker's empty state still has to say what "empty" means.
	 * `NumberPicker` owns its own `<input>`, so the placeholder is written onto
	 * that element rather than passed through config.
	 */
	private setCandidatesPlaceholder(text: string): void {
		const input = this.candidatesPickerElem.querySelector('input');
		if (input) input.placeholder = text;
	}

	/**
	 * Writes the selected phase into the two controls that used to say "this
	 * phase".
	 *
	 * "Sim only BiS-list items (this phase)" left the reader to work out which
	 * phase that was, and it changes under them from the Gear tab. Both labels
	 * now name it. `common.phases.N` is the page's own spelling of a phase
	 * ("Phase 3 (2.2 - T6)"), so the tab agrees with every other phase control
	 * on the page instead of inventing a second wording.
	 *
	 * Called from `refreshCandidatesPlaceholder`, which the staleness listener
	 * already runs on `sim.changeEmitter` -- the emitter a phase change arrives
	 * through. It also runs on gear and talent changes, which is harmless: the
	 * labels are recomputed to the same text.
	 */
	private refreshPhaseLabels(): void {
		const phase = i18n.t(`common.phases.${this.simUI.sim.getPhase()}`);
		// The prune control is a picker, which renders its label once from
		// config, so the phase is written into that label element rather than
		// through the picker's value channel.
		const pruneLabel = this.bisPruneElem.querySelector('.form-label');
		if (pruneLabel) {
			const text = i18n.t('upgrades_tab.prune.only_bis', { phase });
			pruneLabel.textContent = text;
			pruneLabel.setAttribute('title', text);
		}
		// Only the qualifier moves with the phase now; "BiS only" is static text
		// in the label, so the control keeps its name when the phase changes.
		this.bisOnlyControl.setText(i18n.t('upgrades_tab.view.only_bis_qualifier', { phase }));
	}

	/**
	 * Whether the next run should prune to BIS-tagged candidates.
	 *
	 * The single read of the prune checkbox. Gated on visibility so a hidden
	 * control cannot apply an invisible filter — the safety the old force-off
	 * provided, without discarding the user's choice while the control is
	 * away (see `ViewToggle`).
	 */
	private pruneEffective(): boolean {
		return !this.bisPruneElem.classList.contains('d-none') && this.bisPrune;
	}

	private setState(next: RunState) {
		this.state = next;
		this.render();
	}

	/**
	 * Reads the iterations field (D7) at click-time only. The field is a plain
	 * `number` written by the `NumberPicker`; the picker coerces user input in
	 * `getInputValue()` (`parseInt(value || '') || 0`), so this only ever sees
	 * `0` or a positive integer, never `NaN`/`Infinity`. `0` (an empty field)
	 * falls back to the engine's default. Reading it here, not on change, is
	 * what keeps editing mid-run from touching a run in flight — it only
	 * changes what the *next* `run()` sends.
	 */
	private readIterations(): number {
		const parsed = this.iterations;
		return parsed > 0 ? Math.floor(parsed) : DEFAULT_ITERATIONS;
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
		return filterPoolByPhase(this.effectivePool(specId, maxPhase, this.pruneEffective()), maxPhase).filter(e => !isKaelTempLegendary(e.itemId)).length;
	}

	/**
	 * The candidate pool the next run will use: the whole universe, or only its
	 * BIS-tagged entries when the pre-sim prune is on.
	 *
	 * The tag filter is applied to the raw `poolFor` result, before any phase
	 * filtering, at the one place both callers go through. `eligibleCount`
	 * wraps this in the phase and Kael filters; `run()` hands the result to the
	 * engine, which applies its own phase filter. Filtering tags first at both
	 * sites is what keeps the count in the Candidates placeholder equal to the
	 * total the run then reports.
	 *
	 * The prune is deliberately tags-only. It narrows which candidates get
	 * simmed, not what they are compared against: the baseline is the gear read
	 * off the page either way, so every delta means the same thing. The only
	 * visible difference is that an untagged item the player is wearing gets no
	 * greyed "already have it" row of its own, which is what "BiS-list items"
	 * already says. The assumptions console line names the pool a result came
	 * from.
	 */
	private effectivePool(specId: SpecId, maxPhase: RankInput['maxPhase'], pruned: boolean) {
		const pool = poolFor(specId, maxPhase);
		return pruned ? pool.filter(isBisTagged) : pool;
	}

	/**
	 * Picks the runner for this tab's transport, extending `makeSimRunner`'s
	 * branch with the one case that factory cannot answer synchronously.
	 *
	 * `isWasm()` reports the transport the pool *actually has*, resolved from the
	 * worker's own ready message (`worker_pool.ts:315`) rather than guessed from
	 * the URL. It is false only under the packaged `wowsimtbc` server, which
	 * serves `net_worker.js` in place of `sim_worker.js`
	 * (`sim/web/main.go:402-403`) — so a page served by vite gets WASM even when
	 * a Go server happens to be running elsewhere, and that is the correct answer:
	 * posting a bulk request to a server that did not serve the page is a
	 * configuration this deliberately does not support.
	 *
	 * The transport also decides whether bulk screening runs at all: the HTTP
	 * branch screens in batches against the server's native bulk engine, while the
	 * WASM branch takes the per-candidate loop because the in-browser tournament's
	 * per-chunk cost is first-row latency (332 s vs 9.35 s per 25-candidate chunk;
	 * see `makeSimRunner`'s header and ticket 346).
	 *
	 * The user's WASM concurrency setting does not gate the HTTP branch. Upstream
	 * itself declines to apply that setting off-WASM — "Local sim has native
	 * threading" (`ui/core/sim.ts:163-169`) — because the Go server threads one
	 * request over NumCPU internally with no client-side knob. So a setting that
	 * speaks only to in-browser workers must not withhold this path.
	 *
	 * On any failure — no workers, a ready message that never arrives — this falls
	 * back to the factory's runner rather than failing the run: the fallback is a
	 * working per-candidate path, and a transport probe is not worth a dead tab.
	 */
	private simRunner(): Promise<WasmSimRunner | BulkHttpSimRunner> {
		this.simRunnerPromise ??= (async () => {
			try {
				if (await new WorkerPool(1).isWasm()) return this.sim;
			} catch {
				return this.sim;
			}
			return new BulkHttpSimRunner(this.sim.concurrency);
		})();
		return this.simRunnerPromise;
	}

	/**
	 * Reads the Candidates field (candidate-pool.md §5.1.1) at click-time, same
	 * idiom as `readIterations`. The field is a plain `number` coerced by the
	 * `NumberPicker` (see `readIterations`), so it is only ever `0` or a
	 * positive integer. `0` (an empty field) means "no cap" —
	 * `RankInput.candidateCap: undefined`, sim every eligible candidate —
	 * matching the field's own placeholder text rather than silently defaulting
	 * to some other number the user never typed ("no cap" also never sims fewer
	 * candidates than the user could see, which is the safe direction to err).
	 */
	private readCandidateCap(): number | undefined {
		const parsed = this.candidateCap;
		return parsed > 0 ? Math.floor(parsed) : undefined;
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
		this.lastRunSeconds = undefined;
		// Captured once, here, and never recomputed: `lastRunPruned` is a
		// recorded fact about *this* run, reported in the assumptions log line.
		// Re-reading the control later would let a finished run's description
		// drift when the control's visibility or value changes.
		const pruned = this.pruneEffective();
		this.lastRunPruned = pruned;
		// Run click to run finished, the figure the time budget is judged on
		// (docs/verification-log.md's finish-the-tab entry). `performance.now()`
		// rather than `Date.now()`: monotonic, so a clock adjustment mid-run
		// cannot produce a negative or wildly wrong elapsed.
		const startedAt = performance.now();
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

		// Resolved before the run rather than at construction: the transport is
		// only knowable once a worker reports ready (see `simRunner`). Memoised,
		// so only the first run pays the probe.
		const sim = await this.simRunner();

		this.stopButton.disabled = false;
		let ranking: Ranking | PartialRanking;
		// Read by the `finally`'s assumptions log, which also runs when
		// rankUpgrades throws and `ranking` is therefore never assigned.
		let runAssumptions: Assumptions | undefined;
		try {
			ranking = await rankUpgrades(
				input,
				{
					gear: gearSource,
					sim,
					store: this.store,
					clock: () => new Date(),
					raidSimSkeleton: skeleton,
					epWeights: epWeightsFor(specId),
					pool: this.effectivePool(specId, maxPhase, pruned),
					simDatabaseFor: simDatabaseResolverFor(this.simUI.player),
					// `min(workers, memoryCap)` — WasmSimRunner derives this once at
					// construction from the measured per-process memory cost
					// (candidate-pool.md §5.1.2, wasm_sim_runner.ts).
					concurrency: sim.concurrency,
					signal: this.abortController.signal,
				},
				progress => {
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
			runAssumptions = ranking.assumptions;
			// A screening chunk that failed for an engine or transport reason cost
			// this run a batch's worth of speed; the ranking is unaffected because
			// the per-candidate loop priced those candidates instead. Console
			// rather than the page: it explains a slow run to whoever is looking,
			// and says nothing a player would act on (ticket 347).
			for (const fallback of ranking.screeningFallbacks ?? []) {
				console.warn(
					`[upgrades] screening fell back to per-candidate sims for ${fallback.candidates} candidates: ${fallback.reason}`,
				);
			}
		} finally {
			this.stopButton.disabled = true;
			this.abortController = undefined;
			// Set before the terminal setState below so the first render of
			// 'done'/'stopped' already carries the figure.
			this.lastRunSeconds = (performance.now() - startedAt) / 1000;

			// Build metadata, not run provenance: the engine commit and the API
			// version are identical for every run of a given build and say nothing
			// about this run, so they read as developer noise on a page a player is
			// reading (ticket 304 item 9). They still have to be recoverable when
			// someone is diagnosing a bad ranking, so they move here rather than
			// being deleted.
			//
			// In the `finally` rather than after it: a throw from rankUpgrades
			// propagates to the caller's catch, so a line placed after this block
			// never runs for a failed run -- the exact case the paragraph above
			// says the metadata has to survive.
			// Pre-merge review round 3, adversarial axis.
			console.info(`[upgrades] engine ${ENGINE_FORK_COMMIT} · api-v${CURRENT_API_VERSION}`);
			// The run's assumptions followed the same reasoning out of the UI
			// (ticket 318) and land in the same place, for the same reader.
			// Undefined only when rankUpgrades threw, and a diagnostic must never
			// be the thing that masks the real failure.
			if (runAssumptions) this.logAssumptions(runAssumptions);
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
		this.refreshViewControlVisibility();
		this.refreshRaidFilter();
		// Hidden up front on every render; the shortlist path shows it again
		// when it has rows to export. A state with no shortlist -- running,
		// error, or a run that cleared the cutoff with nothing -- therefore
		// leaves no stale payload on screen.
		setControlVisible(this.exportBoxElem, false);
		this.statusElem.replaceChildren(this.statusContent());
		this.renderAnnouncement();
		this.renderSubTabs();
		this.substitutionsHostElem.replaceChildren(this.substitutionsContent());
	}

	/**
	 * Speaks state transitions, not renders. `running` re-renders about once a
	 * second for up to a minute and a half; announcing each tick would bury the
	 * one thing worth hearing, so only a change of `kind` is written here and a
	 * tick within `running` writes nothing. Sighted readers get the live counts
	 * from the visible status line, and AT can poll the progress bar's
	 * `role="progressbar"` for the same numbers on demand.
	 *
	 * Errors go to the assertive region and everything else to the polite one,
	 * and the region not being used is cleared -- a stale failure left in the
	 * alert would be re-announced the next time anything about it changed.
	 */
	private renderAnnouncement(): void {
		const kind = this.state.kind;
		if (kind === this.announcedKind) return;
		this.announcedKind = kind;

		const message = kind === 'error' ? i18n.t('upgrades_tab.status.error', { message: this.state.message }) : (this.statusElem.textContent?.trim() ?? '');
		const isError = kind === 'error';
		this.errorAlertElem.replaceChildren(isError ? message : '');
		this.statusAnnounceElem.replaceChildren(isError ? '' : message);
	}

	private statusContent(): Node {
		switch (this.state.kind) {
			case 'idle':
				return <div className="upgrades-status-line">{i18n.t('upgrades_tab.status.idle')}</div>;
			case 'unsupported-spec':
				return <div className="upgrades-status-line">{i18n.t('upgrades_tab.status.unsupported_spec')}</div>;
			case 'running': {
				// Row-landed count (candidate-pool.md §5.1.5), not just the stage
				// label — "Simming 12/246" is more useful mid-run than the stage
				// name alone, and `landedRows` is exactly the rows that fired a
				// `{ kind: 'row' }` event so far.
				const text = i18n.t('upgrades_tab.status.running_rows', {
					label: progressLabel(this.state.progress),
					count: this.landedRows.length,
				});
				return (
					<div className="upgrades-status-line">
						<span>{text}</span>
						{this.progressBarContent(this.state.progress)}
					</div>
				);
			}
			case 'error':
				return <div className="upgrades-status-line text-danger">{i18n.t('upgrades_tab.status.error', { message: this.state.message })}</div>;
			case 'stopped': {
				const label = i18n.t('upgrades_tab.status.stopped', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return (
					<div className="upgrades-status-line text-warning">
						<span>{label}</span>
						{this.elapsedContent()}
					</div>
				);
			}
			case 'done': {
				const label = i18n.t('upgrades_tab.status.done', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return this.state.stale ? (
					<div className="upgrades-status-line text-warning">
						<span>{label}</span>
						<span>—</span>
						<strong>{i18n.t('upgrades_tab.status.stale')}</strong>
						{this.elapsedContent()}
					</div>
				) : (
					<div className="upgrades-status-line">
						{label} {this.elapsedContent()}
					</div>
				);
			}
		}
	}

	/**
	 * Reuses the Bootstrap `.progress`/`.progress-bar` markup that
	 * `progress_tracker_modal.tsx` already renders for the Bulk tab, so the
	 * bar reads as the site's one progress idiom rather than a second one.
	 * Only the `simming` stage carries a done/total ratio (`rank.ts`'s
	 * `Progress` type); every stage ahead of it (resolving, reading-gear,
	 * composing, building-pool) and the trailing `ranking` stage have none,
	 * so those render the bar in Bootstrap's indeterminate/striped mode
	 * instead of a fabricated width — a 0% or 100% bar before rows have
	 * landed would read as "not started" or "finished" when neither is true.
	 */
	private progressBarContent(progress: Progress): Node {
		const stageProgress = isStageProgress(progress) ? progress : undefined;
		const hasRatio = stageProgress?.stage === 'simming' && stageProgress.total > 0;
		const pct = hasRatio ? Math.min(100, Math.round((stageProgress.done / stageProgress.total) * 100)) : undefined;
		const barRef = ref<HTMLDivElement>();
		const bar = (
			<div
				ref={barRef}
				className={`progress-bar${hasRatio ? '' : ' progress-bar-striped progress-bar-animated'}`}
				style={{ width: hasRatio ? `${pct}%` : '100%' }}
				attributes={{ role: 'progressbar' }}
			/>
		);
		// aria-value* set imperatively, matching progress_tracker_modal.tsx —
		// this JSX helper's `attributes` type only covers `role` for a bare
		// div, not the aria-value* trio.
		barRef.value?.setAttribute('aria-valuemin', '0');
		barRef.value?.setAttribute('aria-valuemax', '100');
		if (pct !== undefined) barRef.value?.setAttribute('aria-valuenow', pct.toString());
		return <div className="upgrades-progress progress">{bar}</div>;
	}

	/**
	 * PLAN.md §4: hide a view control when no data exists for it, because a
	 * toggle that visibly does nothing reads as a bug. Both controls only mean
	 * anything once a run has produced rows carrying the data they act on, so
	 * they appear with the results and disappear with them.
	 *
	 * With the universes this fork ships every spec/phase carries BIS tags, so
	 * the BiS-only control's hidden branch is unreachable with current data; it
	 * exists so a future universe without tags degrades to "no control" rather
	 * than "a filter that empties the table".
	 */
	private refreshViewControlVisibility(): void {
		// Narrowed on `this.state` directly rather than through a boolean, so
		// the compiler can see `ranking` exists on the branch that reads it.
		if (this.state.kind !== 'done') {
			this.setPotentialControl.setVisible(false);
			this.bisOnlyControl.setVisible(false);
			return;
		}
		const items = this.state.ranking.items;
		// Same per-spec floor the ranking gate uses, from this done ranking's own
		// frozen cutoff (in scope and non-null under the guard above) — tickets
		// 331, 332.
		const noiseFloorDps = setBonusNoiseFloorDps(this.state.ranking.cutoff);
		this.setPotentialControl.setVisible(items.some(i => hasRankableSetPotential(i, noiseFloorDps)));
		this.bisOnlyControl.setVisible(items.some(isBisTagged));
	}

	/**
	 * Fills and shows the content filter, on the same hide-when-absent rule as
	 * the other two view controls. It is a `<select>`, not a toggle, so it
	 * borrows only `setControlVisible` from the shared control shape and keeps
	 * its own populate-with-value-preservation logic.
	 *
	 * Options come from the engine's `raidFilterGroups`, so the values -- and
	 * their grouping into zones vs. zoneless buckets -- are the same split
	 * `groupBy: 'raid'` would file rows under. Every row is therefore
	 * reachable under exactly one option, including badge and crafted gear
	 * that a zone-only filter would hide with no way to see it. Each group
	 * renders as an `<optgroup>` so zones and buckets read as the two
	 * different kinds of thing they are, not as one flat list of peers.
	 *
	 * Derived from the *unfiltered* ranking, not the current view: options
	 * computed from the filtered rows would collapse to the one already
	 * selected, and there would be no way back to another zone.
	 *
	 * A selection that no longer exists after a re-run falls back to "All"
	 * rather than silently filtering to nothing.
	 */
	private refreshRaidFilter(): void {
		// Narrowed on `this.state` directly rather than through a boolean, so
		// the compiler can see `ranking` exists on the branch that reads it.
		if (this.state.kind !== 'done') {
			setControlVisible(this.raidFilterLabel, false);
			this.raidFilterSelect.replaceChildren();
			return;
		}
		setControlVisible(this.raidFilterLabel, true);
		const groups = raidFilterGroups(this.state.ranking.items);
		const options = groups.flatMap(group => group.options);
		const previous = this.pendingRaidFilter;
		const keep = options.includes(previous) ? previous : NO_RAID_FILTER;
		this.pendingRaidFilter = keep;
		this.raidFilterSelect.replaceChildren(
			<option value={NO_RAID_FILTER}>{i18n.t('upgrades_tab.view.raid_filter_all')}</option>,
			...groups.map(group => (
				<optgroup label={i18n.t(`upgrades_tab.view.raid_filter_group_${group.key === 'zone' ? 'zone' : 'other'}`)}>
					{group.options.map(option => (
						<option value={option}>{option}</option>
					))}
				</optgroup>
			)),
		);
		this.raidFilterSelect.value = keep;
	}

	/**
	 * The finished run's wall-clock, appended to the done/stopped status. Empty
	 * when no run has finished in this page session. Integer seconds: the figure
	 * is compared against a minutes-scale budget, and sub-second precision would
	 * imply a resolution the surface (a foregrounded browser tab) does not have.
	 */
	private elapsedContent(): Node {
		if (this.lastRunSeconds === undefined) return <></>;
		return <span className="upgrades-elapsed">{i18n.t('upgrades_tab.status.elapsed', { seconds: Math.round(this.lastRunSeconds) })}</span>;
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
		// One view for both renderers. `resultsContent` used to call
		// `currentView()` for itself, so the shopping list and the slot strip
		// each filtered independently; a view option that emptied `rows` then
		// rendered the empty state *and* stripped the sub-tabs below, with no
		// way back except re-running.
		const view = this.state.kind === 'done' ? this.currentView() : undefined;
		// The per-spec set-bonus floor, derived from the ranking's OWN frozen
		// cutoff (never the live picker, which may have moved since the run --
		// see 2117-2119). Computed here at the single done-narrowing point and
		// threaded to the row renderer so the display gate and the ranking gate
		// read the same number for every displayed row (tickets 331, 332).
		const noiseFloorDps =
			this.state.kind === 'done' ? setBonusNoiseFloorDps(this.state.ranking.cutoff) : undefined;
		this.resultsElem.replaceChildren(this.resultsContent(view, noiseFloorDps));

		// Remove any previously-built slot nav items/panes; keep the
		// shopping-list nav item (first child) and pane untouched.
		while (this.tabNavElem.children.length > 1) {
			this.tabNavElem.removeChild(this.tabNavElem.lastElementChild!);
		}
		for (const id of [...this.paneContentElems.keys()]) {
			if (id === 'shopping-list') continue;
			// Remove the pane itself, not its parent. The slot panes are direct
			// children of `tabContentElem`, so `parentElement` is that shared
			// container -- removing it took the whole tab body with it, including
			// the shopping list, and only a re-run brought it back.
			const pane = this.paneContentElems.get(id);
			if (pane?.parentElement === this.tabContentElem) pane.remove();
			this.paneContentElems.delete(id);
		}

		if (view === undefined) return;

		// Slots come from the ranking, not from the filtered view: a display
		// filter must change which rows a pane shows, never which panes exist.
		// Deriving them from `view` let "no tagged row survived" read as "this
		// ranking has no slots" and tear the strip down for good.
		const slotsPresent = slotsInView(this.unfilteredView());
		if (slotsPresent.length === 0) return;

		const buttonById = new Map<SubTabId, HTMLButtonElement>();

		for (const slot of slotsPresent) {
			const id: SubTabId = slot;
			const btnRef = ref<HTMLButtonElement>();
			// The badge counts the same rows the pane will render: both derive
			// from the filtered `view` by the identical predicate
			// `slotPaneContent` uses, inside this one call, so a badge can
			// never disagree with its own pane under a view filter (ticket 304
			// item 10). Tab *existence* still comes from the unfiltered view
			// above -- filtering must change what a pane shows, never which
			// panes exist -- so a filter can empty a tab to (0) rather than
			// removing it, and the tab stays clickable so the user can see
			// that it is empty and why.
			const shortlistCount = view.rows.filter(r => effectiveSlot(r) === slot && !r.belowCutoffInView).length;
			this.tabNavElem.appendChild(
				<li className="nav-item" attributes={{ role: 'presentation' }}>
					<button
						ref={btnRef}
						className={shortlistCount === 0 ? 'nav-link upgrades-subtab-empty' : 'nav-link'}
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
						<span className="upgrades-subtab-count badge rounded-pill">{String(shortlistCount)}</span>
					</button>
				</li>,
			);
			new Tab(btnRef.value!);
			buttonById.set(id, btnRef.value!);

			const paneRef = ref<HTMLDivElement>();
			this.tabContentElem.appendChild(<div id={paneId(id)} className="tab-pane fade" ref={paneRef} />);
			const paneElem = paneRef.value!;
			this.paneContentElems.set(id, paneElem);
			paneElem.replaceChildren(this.slotPaneContent(slot, view, noiseFloorDps));
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

	/**
	 * The view every 'done' renderer draws from: the engine's own `applyView`,
	 * then the tab-local BIS-list filter. Single call site for `applyView` so
	 * the two renderers (shopping list and slot panes) can never disagree about
	 * which rows are on screen.
	 *
	 * Only callable in the 'done' state — `applyView` accepts a complete
	 * `Ranking` only, which is why the 'stopped' path builds its own list.
	 */
	private currentView(): ViewResult {
		return this.applyBisFilter(this.unfilteredView());
	}

	/**
	 * The engine's view of the completed ranking, before any tab-local display
	 * filter. The slot strip is built from this so a filter can never remove a
	 * pane, only empty it.
	 *
	 * Both this and `currentView()` are called only from `renderSubTabs`, which
	 * checks `state.kind === 'done'` first -- that check is the guard, rather
	 * than a throw in here that a future caller would only discover at runtime.
	 */
	private unfilteredView(): ViewResult {
		const ranking = (this.state as Extract<RunState, { kind: 'done' }>).ranking;
		return applyView(ranking, this.currentViewOptions());
	}

	/**
	 * Post-sim display filter: with the toggle on, keep only rows carrying at
	 * least one BIS-list tag. A filter rather than a pin, because a pin leaves
	 * the untagged rows on screen and the ask was to see the BIS list alone.
	 *
	 * Filtering after `applyView` is safe for everything the tab renders.
	 * `belowCutoffInView` is decided per row from the row's own delta, the
	 * baseline and the cutoff, with no reference to the other rows, so dropping
	 * rows cannot change any surviving row's verdict — only how many are below
	 * it, which is recomputed here. `tieGroupId` is set-dependent and is left
	 * as `applyView` computed it, which is harmless because the tab renders no
	 * tie grouping; `groups` is only ever populated when `groupBy` is passed,
	 * and this tab never passes it.
	 */
	private applyBisFilter(view: ViewResult): ViewResult {
		// Read directly, not gated on visibility: this feeds the done-state
		// view, and the control is only ever visible in that state anyway.
		// Gating it would move the view's sort key. Same for set potential.
		if (!this.bisOnlyControl.checked) return view;
		const tagged = (row: ViewRow) => isBisTagged(row);
		const rows = view.rows.filter(tagged);
		const shortlist = view.shortlist.filter(tagged);
		return { ...view, rows, shortlist, belowCutoffCount: rows.length - shortlist.length };
	}

	private currentViewOptions(): ViewOptions {
		// Owned rows are greyed, not hidden — plan §4's sub-tab 1 list does not
		// ask for a hide toggle, so this is fixed rather than user-controlled.
		// The set-potential toggle is read here and nowhere else, and is never
		// persisted: a later three-state control (off / full / weighted) has to
		// be able to replace the checkbox without any other call site changing.
		// The empty string is the no-filter sentinel, not a value the filter
		// could ever legitimately carry: zoneKeyOf returns a zone name or a
		// SOURCE_LABELS bucket, and neither is empty. Core keeps its
		// own `all` handling, which is untouched here.
		// `raid` carries a zone name or a zoneless bucket label; the engine's
		// filter understands both, so badge and crafted gear stay reachable
		// under their own option instead of vanishing under every zone.
		const raid = this.raidFilterSelect.value;
		return {
			hideOwned: false,
			withSetPotential: this.setPotentialControl.checked,
			...(raid === NO_RAID_FILTER ? {} : { raid }),
		};
	}

	private resultsContent(view: ViewResult | undefined, noiseFloorDps: number | undefined): Node {
		if (this.state.kind === 'running') {
			// Skeleton fill (candidate-pool.md §5.1.5): show rows as they land
			// rather than nothing until the whole run finishes. Not run through
			// applyView — there is no complete Ranking yet to view, only the
			// individual rows the row-landed Progress event has delivered.
			return this.landedRowsTable(this.landedRows);
		}
		// Ticket 286 (owner ruling): Stop resets the tab rather than showing a
		// partial table with withheld view controls/sorting. The `PartialRanking`
		// stays on `this.state` for cheap in-memory retention, but nothing here
		// reads it — 'stopped' renders the same empty results table as 'idle'.
		// The substitutions list still renders for 'stopped' (recorded decision,
		// ticket 286 review): it describes the abandoned run's inputs, not its
		// half-computed outputs. The assumptions half of that decision now
		// applies to the console line, which the run's `finally` emits on every
		// exit path including Stop. The stopped status wording is reconciled
		// under ticket 290's state-design pass.
		// No run in this page session yet: say so, rather than leaving the
		// results area blank. An empty panel reads as "it found nothing",
		// which is a different (and discouraging) claim from "nothing has
		// been asked yet".
		if (view === undefined) {
			// Idle is the one empty state that gets a call to action: pressing
			// Run is exactly what resolves it. The unsupported-spec variant
			// below deliberately has none, because Run cannot help there.
			return this.state.kind === 'unsupported-spec'
				? this.emptyState(i18n.t('upgrades_tab.status.unsupported_spec'), i18n.t('upgrades_tab.results.empty_unsupported_spec_body'))
				: this.emptyState(i18n.t('upgrades_tab.results.empty_no_ranking'), i18n.t('upgrades_tab.results.empty_no_ranking_body'), () =>
						this.runButton.click(),
					);
		}
		// The export tracks the shopping list, so it is computed here rather than
		// inside `rowsTable`: that renderer is shared with every slot pane, and
		// computing it there let the last pane rendered -- a single slot's
		// subset -- overwrite the payload. Exporting a slot-grouped subset is
		// the exact failure ticket 314 names, since it throws away the
		// cross-slot ranked order the payload exists to carry.
		//
		// The same sort the table applies is applied here, so the payload order
		// is the displayed order including a column-sort click.
		const exported = this.resultsSort ? sortRows(view.shortlist, this.resultsSort) : view.shortlist;
		this.updateExport(exported);
		return this.resultsBlock(this.rowsTable(view.shortlist, view.rows, noiseFloorDps), view.shortlist.length);
	}

	/**
	 * The finished table under the site's own `.content-block` header, the same
	 * markup `ContentBlock` builds (`content_block.tsx`: `h6.content-block-title`
	 * inside `.content-block-header`) -- an `h6` and the partial's bottom border,
	 * not a local heading rule. The classes are written out rather than
	 * constructed through `new ContentBlock(...)` because this node is rebuilt by
	 * `replaceChildren` on every view change, and the component owns a persistent
	 * root element it appends to a parent.
	 *
	 * Only the table gets a header. The empty states carry their own title and a
	 * second one above them would say the same thing twice, and the running
	 * skeleton has no final count to name yet.
	 */
	private resultsBlock(table: Node, shortlistCount: number): Node {
		return (
			<div className="upgrades-results-block content-block">
				<div className="content-block-header">
					<h6 className="content-block-title">{i18n.t('upgrades_tab.results.heading')}</h6>
					<span className="upgrades-results-count">{i18n.t('upgrades_tab.results.heading_count', { count: shortlistCount })}</span>
				</div>
				<div className="content-block-body">{table}</div>
			</div>
		);
	}

	/**
	 * The three empty states say three different things (ticket 304 item 2):
	 * "nothing has been asked yet", "this is still filling in", and "the run
	 * worked and found nothing". Only the first two render through here -- the
	 * pending one is a single transient line and gets no heading, because a
	 * heading and a button would invite the user to interrupt their own run.
	 *
	 * `onAction` is optional so the same shape serves the state that can be
	 * resolved by pressing Run and the one that cannot.
	 */
	private emptyState(title: string, body: string, onAction?: () => void): Node {
		return (
			<div className="upgrades-empty-state">
				<p className="upgrades-empty-state-title">{title}</p>
				<p className="upgrades-empty-state-body">{body}</p>
				{onAction ? (
					<button className="btn btn-primary btn-sm" type="button" onclick={onAction}>
						{i18n.t('upgrades_tab.run')}
					</button>
				) : null}
			</div>
		);
	}

	/**
	 * Plain row list for states with no complete `Ranking` to run through
	 * `applyView` — mid-run skeleton fill and the Stop-truncated result
	 * (candidate-pool.md §5.1.4, §5.1.5). Rows Stop never reached
	 * (`simmed: false`) are filtered out here rather than shown with a
	 * placeholder 0 delta, which would misread as "no upgrade" instead of
	 * "not simmed".
	 */
	private landedRowsTable(rows: readonly RankedItem[]): Node {
		const simmedRows = rows.filter(r => r.simmed !== false);
		if (simmedRows.length === 0) {
			// No row has landed yet — nothing has been measured, so this is the
			// "no results yet" message, not "the run found nothing".
			return <div className="upgrades-text-secondary">{i18n.t('upgrades_tab.results.rows_pending')}</div>;
		}
		// Sorted at render time, on a copy. The engine emits no ordering for
		// these rows — there is no complete Ranking to run through applyView
		// yet — and rows land in whatever order their sims finish, so without
		// this the reader watches an unsorted list (ticket 278). Copying rather
		// than sorting in place: `rows` is the caller's array, and for the
		// mid-run path it is the accumulating `landedRows` buffer.
		const sorted = [...simmedRows].sort((a, b) => b.deltaDps - a.deltaDps);
		// Marked provisional: this table's Rank column is a position in the
		// rows landed *so far*, not the engine's final `rank`, and a row that
		// has not been simmed yet is simply absent. The class lets the styling
		// say so, alongside the running status line's own "N rows landed".
		return (
			<table className="upgrades-results-table upgrades-results-table-provisional table table-sm">
				{resultsTableHead()}
				{/* Mid-run skeleton: no ranking yet, so no per-spec floor exists —
				    pass undefined and `setBonusLine` skips the prospective line. */}
				<tbody>{sorted.map((row, i) => this.resultRow(row, { rankText: String(i + 1) }, undefined))}</tbody>
			</table>
		);
	}

	private slotPaneContent(slot: SimOrderName, view: ViewResult, noiseFloorDps: number | undefined): Node {
		const rowsForSlot = view.rows.filter(r => effectiveSlot(r) === slot);
		const shortlistForSlot = rowsForSlot.filter(r => !r.belowCutoffInView);
		return <div className="p-gap">{this.rowsTable(shortlistForSlot, rowsForSlot, noiseFloorDps)}</div>;
	}

	/**
	 * Shared table renderer for the shopping list and every slot pane — same
	 * columns, same cutoff-behind-expand behaviour (plan §4), parameterized
	 * only by which rows to show.
	 *
	 * `shortlist`/`allRows` arrive in the engine's own order (`applyView`'s
	 * `compareRows`); `this.resultsSort`, when set, reorders the rendered rows
	 * only — it never touches which rows are shortlisted vs. below-cutoff
	 * (ticket 280).
	 */
	private rowsTable(shortlist: ViewRow[], allRows: ViewRow[], noiseFloorDps: number | undefined): Node {
		// Items the player already wears cannot be an upgrade, so listing them
		// under "below the cutoff" is noise that makes the group read as broken
		// (ticket 304 item 7). Owned rows are dropped from this group only --
		// owned *shortlist* rows stay kept-and-greyed, which is the behaviour
		// ticket 269 is about, and `hideOwned`/`greyOwned` are untouched.
		//
		// The engine's `belowCutoffCount` (engine/view.ts) deliberately keeps
		// its delta-only semantics and still counts owned rows, so the rendered
		// group is that count minus the owned rows. That divergence is safe
		// today because the count has no reader anywhere in this UI beyond its
		// own construction; a future consumer should read this comment first.
		//
		// Dropping owned rows is safe only because of the worn-item guard in
		// engine/rank.ts: an owned item is re-simmed into the slot it already
		// occupies and nowhere else, so its delta is ~0 by construction and
		// nothing real is hidden. Ticket 308 recorded second-copy placement of
		// non-unique rings and trinkets as deliberately out of scope, which is
		// what keeps that guard standing. Whoever implements it (ticket 309)
		// must change this filter in the same change, because an owned item
		// could then carry a genuine positive delta in the other slot -- and
		// `ViewRow` cannot express the distinction today: `owned` comes from
		// an item-id set membership test, so it records *that* an item is
		// worn, never *where*. The condition this filter would need has no
		// left-hand side until that plumbing exists.
		const belowCutoffRows = allRows.filter(r => r.belowCutoffInView && !r.owned);
		if (shortlist.length === 0 && belowCutoffRows.length === 0) {
			// A result, not an absence: the run worked and nothing cleared the
			// cutoff. No Run call to action -- re-running the same settings
			// gives the same answer, so the body points at the filters instead.
			return this.emptyState(i18n.t('upgrades_tab.results.empty_no_upgrades'), i18n.t('upgrades_tab.results.empty_no_upgrades_body'));
		}
		const sortedShortlist = this.resultsSort ? sortRows(shortlist, this.resultsSort) : shortlist;
		const table = (
			<table className="upgrades-results-table table table-sm">
				{this.sortableResultsTableHead()}
				<tbody>
					{sortedShortlist.length > 0 ? (
						// The frozen cutoff is threaded only to the shortlist: below-cutoff
						// rows were admitted by no arm and the mid-run table has no cutoff
						// verdict yet, so only these rows can carry the %-arm marker (254).
						sortedShortlist.map((row, i) => this.resultRow(row, { rankText: String(i + 1) }, noiseFloorDps, this.state.kind === 'done' ? this.state.ranking.cutoff : undefined))
					) : (
						<tr>
							<td colSpan={5} className="upgrades-text-secondary">
								{i18n.t('upgrades_tab.results.empty_no_upgrades')}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		);

		return (
			<>
				{/*
				 * Each result group is its own `.upgrades-result-group` so the
				 * divider rule has siblings to match on: the shortlist table and
				 * the below-cutoff disclosure are two groups, and the rule draws a
				 * line between them only when both are present. The idiom is the
				 * bulk renderer's (`_bulk_sim_result_renderer.scss`:
				 * `&:not(:last-child):not(:only-child)` + `--border-default` +
				 * `--gap-width`), which is what item 10's "take inspiration from
				 * the batch UI" asks for -- that file's dividers are the reusable
				 * part; its `flex` ratios describe a row of gear combos, not a
				 * table, and its emphasis of a first result does not exist to
				 * borrow (round-3 review S2, ticket 307).
				 */}
				<div className="upgrades-result-group">{table}</div>
				{belowCutoffRows.length > 0 ? <div className="upgrades-result-group">{this.expandableRowGroup(belowCutoffRows, noiseFloorDps)}</div> : null}
			</>
		);
	}

	/**
	 * The done-state header: same columns as `resultsTableHead()`, each one a
	 * click target that sorts the shopping list and every slot pane by that
	 * column (ticket 280). One shared `resultsSort` drives all of them, so
	 * clicking a header in one pane and switching sub-tabs shows the other
	 * pane sorted the same way, matching how the view-option checkboxes are
	 * one switch for every pane rather than per-pane state.
	 *
	 * Clicking the already-active column reverses direction, the same
	 * click-to-toggle idiom `gear_picker/item_list.tsx`'s `sort()` uses for
	 * its ilvl/EP headers. `aria-sort` on the active `<th>` is the one thing
	 * that idiom does not carry — added here since a `<table>` header is the
	 * case ARIA defines the attribute for.
	 */
	private sortableResultsTableHead(): Node {
		const rankCell = (
			<th className="upgrades-results-header" attributes={{ role: 'columnheader' }}>
				{rankColumnLabel()}
			</th>
		);
		const cells = RESULTS_SORT_COLUMNS.map(column => {
			const active = this.resultsSort?.column === column;
			const ariaSort = active ? (this.resultsSort!.direction === 'asc' ? 'ascending' : 'descending') : 'none';
			const onclick = (event: MouseEvent) => {
				event.preventDefault();
				this.toggleResultsSort(column);
			};
			return (
				<th
					className="upgrades-results-sortable-header"
					attributes={{
						role: 'columnheader',
						'aria-sort': ariaSort,
					}}>
					<button type="button" className="upgrades-results-sort-button" onclick={onclick}>
						{resultsSortColumnLabel(column)}
						{active ? <span className="upgrades-results-sort-indicator">{this.resultsSort!.direction === 'asc' ? '▲' : '▼'}</span> : null}
					</button>
				</th>
			);
		});
		return (
			<thead>
				<tr>
					{rankCell}
					{cells}
				</tr>
			</thead>
		);
	}

	/**
	 * The click handler behind every sortable header: first click on a column
	 * sorts descending (matching the engine's own delta-descending default, so
	 * clicking "DPS" once lands on the order the page already opened with),
	 * a second click on the same column reverses it, and clicking a different
	 * column starts that column fresh at descending. Re-renders through
	 * `renderSubTabs()` alone — sorting is a display concern, never a re-run,
	 * so nothing else in `render()` needs to run again.
	 */
	private toggleResultsSort(column: ResultsSortColumn): void {
		const current = this.resultsSort;
		this.resultsSort =
			current && current.column === column ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: 'desc' };
		this.renderSubTabs();
	}

	/**
	 * The below-cutoff rows, hidden behind a toggle (candidate-pool.md §6.1:
	 * "renders behind its own expand", "hidden, never deleted").
	 */
	private expandableRowGroup(rows: ViewRow[], noiseFloorDps: number | undefined): Node {
		const tbodyRef = ref<HTMLTableSectionElement>();
		// Native <details>, the disclosure idiom this tab settled on.
		// The hand-rolled version was a button toggling `d-none` and swapping
		// its own label — two idioms for one behaviour on one screen, and the
		// browser's own gives keyboard and screen-reader semantics for free.
		// The element's open/closed state carries the show/hide verb, so the
		// summary keeps only the part that says something either way: the count.
		const details = (
			<details className="upgrades-below-cutoff-group">
				<summary>{i18n.t('upgrades_tab.results.below_cutoff_group', { count: rows.length })}</summary>
				<table className="upgrades-results-table upgrades-below-cutoff-table table table-sm">
					<tbody ref={tbodyRef} />
				</table>
			</details>
		);
		// Same shared sort as the shortlist table above it (ticket 280) — the
		// header buttons live on the shortlist table only, but a below-cutoff
		// row group under a sorted shortlist reading in the old engine order
		// would look like the sort silently stopped at the fold.
		const sorted = this.resultsSort ? sortRows(rows, this.resultsSort) : rows;
		// Numbered 1..N within this table, independent of the shortlist above it
		// (owner ruling, ticket 287 follow-through): the below-cutoff group is
		// its own set of displayed items, not a continuation of the shortlist's
		// count, and the engine's `rank` this used to show is no longer surfaced
		// anywhere in the UI.
		tbodyRef.value!.replaceChildren(...sorted.map((row, i) => this.resultRow(row, { rankText: String(i + 1) }, noiseFloorDps)));
		return details;
	}

	/**
	 * The one row renderer, shared by the done-state tables and the mid-run
	 * skeleton fill (ticket 278).
	 *
	 * It takes a `RankedItem`, not a `ViewRow`: `belowCutoffInView` is assigned
	 * only inside `applyView`, and mid-run there is no complete `Ranking` to run
	 * through it. Nothing in a row's own markup depends on that flag anyway —
	 * the callers group below-cutoff rows into their own table — so the only
	 * difference the renderer needs handed to it is the Rank text.
	 *
	 * `rankText` is always a caller-supplied 1-based position in whichever
	 * table this row is rendering into (the shortlist, a slot pane, the
	 * below-cutoff group, or the mid-run skeleton), never the engine's own
	 * `RankedItem.rank` — the UI no longer shows that value (owner ruling,
	 * ticket 287 follow-through).
	 *
	 * `noiseFloorDps` is the per-spec set-bonus floor from the done ranking's
	 * frozen cutoff, or `undefined` on the mid-run skeleton path (no ranking
	 * exists yet); it is threaded straight to `setBonusLine`, which skips the
	 * prospective-bonus line when the floor is absent (tickets 331, 332).
	 *
	 * `cutoff` is the same done ranking's frozen cutoff (or `undefined` mid-run),
	 * threaded so a row admitted above the fold by the percentage arm alone can
	 * say so (ticket 254): the cutoff is an OR (abs OR pct), and a shortlisted
	 * row whose absolute DPS is below the abs threshold reads as if it broke the
	 * absolute rule unless the %-arm is named. The marker's content is the
	 * correctness fix; its visual polish is a follow-up (styling wave).
	 */
	private resultRow(row: RankedItem, display: { rankText: string }, noiseFloorDps: number | undefined, cutoff?: Cutoff): Node {
		const deltaLabel = formatDelta(row.deltaDps);
		const setLine = this.setBonusLine(row, noiseFloorDps);
		const setPackageLine = this.setPackageLine(row, noiseFloorDps);
		const cutoffArmLine = cutoff && cutoffAdmittingArm(row.deltaDps, row.deltaPct, cutoff) === 'pct'
			? (
				<small className="upgrades-cutoff-arm" title={i18n.t('upgrades_tab.cutoff.pct_arm_title', { pct: formatDelta(cutoff.pct), abs: cutoff.absDps })}>
					{i18n.t('upgrades_tab.cutoff.pct_arm')}
				</small>
			)
			: null;
		return (
			<tr className={row.owned ? 'upgrades-row-owned' : ''}>
				<td>{display.rankText}</td>
				<td>{this.itemCell(row)}</td>
				<td>{slotLabel(effectiveSlot(row))}</td>
				<td>
					{deltaLabel}
					{setLine}
					{setPackageLine}
					{cutoffArmLine}
				</td>
				<td>{sourceCell(row, this.simUI.sim)}</td>
			</tr>
		);
	}

	/**
	 * Writes the ThatsMyBis payload for the rows currently on screen (ticket
	 * 314), less the ones the player already wears (ticket 316).
	 *
	 * **The shortlist only, in `sortedShortlist` order.** Below-cutoff rows are
	 * excluded deliberately: they are the rows the ranking says not to
	 * prioritize, and a thatsmybis payload is a priority list. The per-slot
	 * panes are never the source either — they are grouped slot by slot, so
	 * exporting them would throw away the cross-slot ranked order that is the
	 * whole point of the payload (the rule at `rank-report.ts:873-876`).
	 *
	 * Deliberate drift: mirrors `wowsimsItemIdsJson`
	 * (`packages/core/src/rank-report-rules.ts:452`) and `updateExport`'s
	 * first-seen `seen` map (`rank-report.ts:877-889`), neither of which the
	 * fork can import. Ids only — enchants and gems belong to the worn item,
	 * and a candidate is one the player does not have yet.
	 *
	 * Owned rows are dropped here and only here (ticket 316): a thatsmybis
	 * payload is a priority list, and asking the raid to award an item the
	 * player already wears is not a priority. The table still renders those
	 * rows greyed — that is ticket 269's behaviour and this filter must not
	 * reach it. `row.owned` is the same flag the greying and the below-cutoff
	 * filter read, set from the equipped ids in `engine/rank.ts`.
	 *
	 * The count is derived from `items` rather than from `rows`, so it cannot
	 * claim rows the copied JSON does not contain. When every row is owned the
	 * payload is a well-formed `{"items": []}` with a zero count.
	 */
	private updateExport(rows: readonly ViewRow[]): void {
		const seen = new Set<number>();
		const items: { id: number }[] = [];
		for (const row of rows) {
			if (row.owned === true) continue;
			// Choose the id for this flavour first, then dedupe on it: two rows
			// that resolve to the same emitted id are one line in the payload.
			const id = this.exportTokenFlavour ? this.exportIdForRow(row) : row.itemId;
			if (seen.has(id)) continue;
			seen.add(id);
			items.push({ id });
		}
		this.exportAreaElem.value = JSON.stringify({ items }, null, 2);
		this.exportCountElem.textContent = i18n.t('upgrades_tab.export.count', { count: items.length });
		this.exportFlavourCaptionElem.textContent = i18n.t(
			this.exportTokenFlavour
				? 'upgrades_tab.export.flavour_tokens'
				: 'upgrades_tab.export.flavour_gear',
		);
		setControlVisible(this.exportBoxElem, items.length > 0);
	}

	/**
	 * The id this row emits under the token flavour (ticket 126): the class
	 * token that actually drops in the raid for a tier piece, else the gear id.
	 *
	 * Local re-implementation of `tokenIdForExport`
	 * (`packages/core/src/rank-report-rules.ts`) — imports across the port
	 * boundary are impossible (314's verified finding), so the logic is
	 * mirrored, not shared. Reads every source, not just the primary: a tier
	 * row can carry a drop source ahead of its token source, and the token id
	 * is the one wanted wherever it sits. `tokenId` rides on the `token`
	 * source, threaded in by `assemble_universe.py` and carried through the
	 * bundled universe → engine → `ViewRow.sources` verbatim. A Sunmote token
	 * has no single tradeable id and falls through to the gear id, exactly as
	 * the core function does.
	 */
	private exportIdForRow(row: ViewRow): number {
		const sources = row.sources ?? [row.source];
		for (const s of sources) {
			if (s.kind === 'token') {
				const tokenId = (s as { tokenId?: number }).tokenId;
				if (typeof tokenId === 'number') return tokenId;
			}
		}
		return row.itemId;
	}

	/**
	 * How much of this row's figure is set bonus (ticket 313). The text is
	 * informational and renders in BOTH toggle states with identical wording
	 * (owner revision 2): the set-potential toggle governs only whether
	 * prospective bonuses affect the ranking/sort, not whether the text shows.
	 *
	 * The number shown is the raw `prospectiveBonusDps`, which is exactly what
	 * the view adds to `deltaDps` when the toggle is on (`view.ts:163,169-172`).
	 * The report path discounts its own figure through `SET_POTENTIAL_WEIGHTS`;
	 * that weighting does not apply here, and showing a discounted number would
	 * fail to reconcile with the on-screen ordering.
	 *
	 * Four states, which must not be able to be read as one another:
	 *
	 * (a) prospective — the bonus is *not* yet inside `deltaDps`, so it is shown
	 *     as a separate figure with the piece counts that would earn it.
	 * (b) crossing — the bonus is already inside `deltaDps`. No second number,
	 *     or a reader would add it to the delta a second time.
	 * (c) confounded — the figure is inflated by breaking another set bonus and
	 *     the view refuses to rank on it (ticket 90), so it is disclosed with
	 *     that said plainly rather than presented as a clean gain.
	 * (d) a set context with no populated bonus and no crossing — a real state
	 *     (`rank.ts:1431-1440` only populates `prospectiveBonusDps` when the
	 *     swap advances the piece count below a threshold) with nothing to say.
	 */
	private setBonusLine(row: RankedItem, noiseFloorDps: number | undefined): Node | null {
		const ctx = row.setContext;
		if (!ctx) return null;

		const breaks = ctx.prospectiveBonusBreaks;
		if (breaks?.length) {
			const broken = breaks[0];
			return (
				<small className="upgrades-set-bonus upgrades-set-bonus-confounded">
					{i18n.t('upgrades_tab.set_bonus.confounded', {
						dps: (ctx.prospectiveBonusDps ?? 0).toFixed(1),
						threshold: ctx.nextThreshold,
						broken: broken.setName,
						brokenThreshold: broken.threshold,
					})}
				</small>
			);
		}

		if (ctx.crossesThreshold) {
			return (
				<small className="upgrades-set-bonus">{i18n.t('upgrades_tab.set_bonus.crosses', { threshold: ctx.piecesAfterSwap })}</small>
			);
		}

		// Only surface a bonus that clears sim noise. The floor is per-spec
		// (`setBonusNoiseFloorDps` of the ranking's OWN frozen cutoff), threaded
		// in as a parameter so display and ranking gate every displayed row on
		// the same number — never a live picker lookup, which may have moved
		// since the run (tickets 331, 332). When the floor is absent the row came
		// from the mid-run skeleton, which carries no ranking; it has no honest
		// floor to gate against yet, so the prospective line is skipped entirely.
		// A near-zero measurement shown raw reads as a real figure -- "-4.1 set
		// bonus" looks like a negative bonus when the honest statement is
		// "nothing measurable". Noise reduction is a separate item (ticket 105).
		if (
			noiseFloorDps !== undefined &&
			ctx.prospectiveBonusDps !== undefined &&
			ctx.prospectiveBonusDps > noiseFloorDps &&
			ctx.nextThreshold !== null
		) {
			return (
				<small className="upgrades-set-bonus">
					{i18n.t('upgrades_tab.set_bonus.prospective', {
						worn: ctx.piecesWornBefore,
						dps: ctx.prospectiveBonusDps.toFixed(1),
						threshold: ctx.nextThreshold,
					})}
				</small>
			);
		}

		return null;
	}

	/**
	 * Discloses a reachable HIGHER-threshold set bonus the row's own line does
	 * not show (ticket 336). `setBonusLine` shows the nearest measurable
	 * threshold only — for a 2pc-implemented tier set that stops at the 2pc and
	 * the row is silent about a 4pc that is a real, reachable upgrade (feral
	 * Thunderheart 4pc measures +64 DPS in committed data). The 4pc figure
	 * already rides on the row as `setContext.packages[]`; the tab just never
	 * rendered it.
	 *
	 * This is DISCLOSURE, never credit. It re-implements the report path's
	 * package-as-card idea locally — `packages/core/src/rank-report.ts:136-142`
	 * (the per-row `pkg` span) and `rank-report-rules.ts:669-686`
	 * (`formatPackageMembershipLine`) — which the fork cannot import
	 * (upgrades_tab.tsx:262-263). Ticket 91 deliberately rejected smearing 4pc
	 * credit onto the row number, and this line does the same: it reads
	 * `packages[]` only, writes no number the sort consults (the sort keys off
	 * `prospectiveBonusDps` in `view.ts`, never `packages[]`), and adds nothing
	 * to `deltaDps`.
	 *
	 * Gating, so a disclosed figure never reads as a clean measured gain the row
	 * did not earn (the text itself renders in both toggle states, owner rev 2):
	 * - Only packages ABOVE the threshold the row already shows
	 *   (`ctx.nextThreshold`), so this never duplicates that line.
	 * - Only packages whose measured `deltaDps` clears the same per-spec noise
	 *   floor the prospective line uses, so a sub-noise or negative package (ret
	 *   4pc is noise-around-zero) is not surfaced as a real bonus.
	 * - Never in the confounded or crossing states: those carry their own line,
	 *   and a confounded package is not a clean disclosure (ticket 90).
	 */
	private setPackageLine(row: RankedItem, noiseFloorDps: number | undefined): Node | null {
		if (noiseFloorDps === undefined) return null;
		const ctx = row.setContext;
		if (!ctx || !ctx.packages || ctx.packages.length === 0) return null;
		if (ctx.crossesThreshold || ctx.prospectiveBonusBreaks?.length) return null;

		const shownThreshold = ctx.nextThreshold ?? 0;
		const reachable = ctx.packages
			.filter(pkg => pkg.threshold > shownThreshold && pkg.deltaDps > noiseFloorDps)
			.sort((a, b) => a.threshold - b.threshold);
		if (reachable.length === 0) return null;

		return (
			<>
				{reachable.map(pkg => (
					<small className="upgrades-set-package">
						{i18n.t('upgrades_tab.set_bonus.package_disclosure', {
							worn: ctx.piecesWornBefore,
							dps: pkg.deltaDps.toFixed(1),
							threshold: pkg.threshold,
						})}
					</small>
				))}
			</>
		);
	}

	/**
	 * The Item cell: icon + quality-coloured name + wowhead tooltip link, the
	 * same idiom `item_list.tsx`'s `createItemElem` uses for every other item
	 * row on the site (WP3). `RankedItem` carries only `itemId`/`name`, not
	 * quality or an icon URL, so both come from `ActionId.fromItemId` --
	 * `.fill()` resolves them the same way the gear picker's own list items do
	 * (icon URL and canonical name from wowhead/local data), and
	 * `setWowheadHref` + the `whtticon: false` dataset flag reproduce the same
	 * tooltip-link markup so the browser's wowhead script picks it up
	 * identically to any other item link on the page.
	 */
	private itemCell(row: RankedItem): Node {
		const nameElem = ref<HTMLElement>();
		const iconElem = ref<HTMLImageElement>();
		const anchorElem = ref<HTMLAnchorElement>();
		const bisLabel = row.bisTags.includes('BiS')
			? i18n.t('upgrades_tab.results.bis_badge')
			: row.bisTags.includes('Alt')
				? i18n.t('upgrades_tab.results.alt_badge')
				: undefined;

		const cell = (
			<span className="upgrades-item-cell">
				<a className="upgrades-item-link" ref={anchorElem} dataset={{ whtticon: 'false' }}>
					<img className="upgrades-item-icon" ref={iconElem} />
					<span className="upgrades-item-name" ref={nameElem}>
						{row.name}
					</span>
				</a>
				{bisLabel ? <span className="badge rounded-pill upgrades-bis-badge ms-1">{bisLabel}</span> : null}
				{row.owned ? <span className="upgrades-text-secondary ms-1">{`(${i18n.t('upgrades_tab.results.owned')})`}</span> : null}
			</span>
		);

		const actionId = ActionId.fromItemId(row.itemId);
		actionId.fill().then(filledId => {
			filledId.setWowheadHref(anchorElem.value!);
			iconElem.value!.src = filledId.iconUrl;
		});
		const item = Database.getSync().getItemById(row.itemId);
		setItemQualityCssClass(nameElem.value!, item?.quality ?? null);

		return cell;
	}

	/**
	 * The run's assumptions, to the console rather than to the page (ticket 318).
	 *
	 * Every row this used to render was either a restatement of a control the
	 * user had just set -- iterations, max phase, candidate pool -- or internal
	 * detail no player can act on, so the block cost a player screen space and
	 * gave nothing back. It is still what someone diagnosing a bad ranking reads,
	 * which is why this logs rather than deletes.
	 *
	 * Plain English rather than the `i18n` strings the drawer used: a console
	 * line is a diagnostic for whoever is debugging this build, not localised UI.
	 * Its locale keys go with it.
	 */
	private logAssumptions(a: Assumptions): void {
		const cap = this.readCandidateCap();
		// The run's own phase, not the picker's current value -- this describes
		// the finished run, and the picker may have moved since.
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		const poolSource = specId ? poolSourceFor(specId, a.maxPhase as ContentPhase) : undefined;
		const epDisclosure = specId ? epWeightsDisclosureFor(specId, a.maxPhase as ContentPhase) : undefined;
		const unsourced = specId ? unsourcedCountFor(specId, a.maxPhase as ContentPhase) : 0;
		const bisTagPhase = specId ? bisTagPhaseFor(specId, a.maxPhase as ContentPhase) : undefined;

		const lines = [
			`seeds: ${a.seeds.join(', ')}`,
			`iterations: ${a.iterations}`,
			`max phase: ${a.maxPhase}`,
			`candidate pool: ${this.lastRunPruned ? `BiS-list items for phase ${a.maxPhase}` : 'every eligible item'}`,
		];
		// Which bundled file the run drew from. The chosen file is not always the
		// selected phase's -- data.ts falls back to the highest phase with data at
		// or below it -- so naming it stops a reader assuming a p4 selection read
		// a p4 file.
		if (poolSource) lines.push(`pool source: ${poolSource.file} (${poolSource.entries} entries)`);
		// The degradations a run may carry. Each states itself rather than being
		// inferred from a missing field.
		if (epDisclosure) lines.push(`EP weights: written for ${epDisclosure.from}, ranking ${epDisclosure.requested}`);
		if (bisTagPhase && bisTagPhase.tagsFromPhase < bisTagPhase.requestedPhase) {
			lines.push(`BiS tags: from P${bisTagPhase.tagsFromPhase} sets, ranking P${bisTagPhase.requestedPhase}`);
		}
		if (specId && cutoffIsUnmeasuredFor(specId)) lines.push('cutoff: borrowed from Retribution Paladin, unmeasured for this spec');
		if (unsourced > 0) lines.push(`source attribution: partial, ${unsourced} items admitted by database phase only`);
		if (cap !== undefined) lines.push(`candidate cap: top ${cap} simmed in full, plus anything you already own`);

		console.info(`[upgrades] assumptions — ${lines.join(' · ')}`);
	}

	/**
	 * Every candidate the run dropped, and why. Nothing rendered these before
	 * (ticket 156): the engine has always recorded dropped candidates in
	 * `substitutions`, but the drawer showed only the run's settings, so a run
	 * that lost candidates to sim panics looked identical on the page to one
	 * where every candidate simmed cleanly. That is what let a run whose sims
	 * all failed read as "no upgrades found above the cutoff".
	 *
	 * Kept on the page when the assumptions block left it for the console
	 * (ticket 318): a dropped candidate is a reason an item a player expected is
	 * missing from the list, which is the opposite of the developer detail that
	 * demotion targeted. It renders in its own host now rather than inside the
	 * assumptions drawer that used to contain it, and the leading `<hr />` went
	 * with that drawer -- it separated this list from the rows above it, and
	 * there are no longer any rows above it.
	 */
	private substitutionsContent(): Node {
		if (this.state.kind !== 'done' && this.state.kind !== 'stopped') return <></>;
		const subs = this.state.ranking.substitutions;
		if (subs.length === 0) return <></>;
		return (
			<>
				<p className="mb-1">
					<strong>{i18n.t('upgrades_tab.assumptions.substitutions_title', { count: subs.length })}</strong>
				</p>
				<dl className="upgrades-assumptions-grid mb-0 upgrades-substitutions">
					{subs.map(s => {
						// The page shows one line; the diagnostic record goes to the console
						// rather than being lost, since this tab has no JSON artifact to
						// hold it (ticket 311).
						const shown = firstLineOf(s.detail);
						if (shown !== s.detail) console.warn(`[upgrades] ${s.field}: ${s.detail}`);
						return (
							<>
								<dt className="upgrades-assumptions-term">{s.field}</dt>
								<dd className="upgrades-assumptions-desc">{shown}</dd>
							</>
						);
					})}
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
function effectiveSlot(row: Pick<RankedItem, 'slot' | 'slotChoice'>): SimOrderName {
	return row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0];
}

/**
 * Whether a row has set-bonus potential the view would actually rank on.
 *
 * Deliberate drift: this mirrors `rankableSetPotential(item, noiseFloorDps) > 0`
 * in `view.ts`, which is private to that module. Exporting it would be an engine
 * edit, and every engine edit costs a PROVENANCE re-hash and an E-W3 run — too
 * much for a predicate that only decides whether a checkbox is on screen. If
 * `view.ts`'s definition changes, this must change with it. The floor is now
 * per-spec (`setBonusNoiseFloorDps` of the ranking's frozen cutoff, tickets
 * 331/332); the caller derives it and passes it in, so this predicate gates on
 * the same number the ranking did.
 *
 * The `prospectiveBonusBreaks` half is not an optimisation: a row whose bonus
 * is confounded by breaking another set gets no credit from the view either
 * (the `(k-1)*B` inflation argument, PLAN.md ticket 90), so counting it here
 * would offer a toggle that changes nothing.
 */
function hasRankableSetPotential(item: Ranking['items'][number], noiseFloorDps: number): boolean {
	if (item.setContext?.prospectiveBonusBreaks?.length) return false;
	return (item.setContext?.prospectiveBonusDps ?? 0) > noiseFloorDps;
}

/** Slots with at least one ranked candidate, in SIM_ORDER (stable, matches the page's own gear ordering). */
function slotsInView(view: ViewResult): SimOrderName[] {
	const present = new Set<SimOrderName>();
	for (const row of view.rows) present.add(effectiveSlot(row));
	return SIM_ORDER.filter(s => present.has(s));
}

function sourceLabel(source: ItemSource): string {
	if ('zone' in source) return source.zone;
	return SOURCE_LABELS[source.kind] ?? source.kind;
}

/**
 * The Source cell: item_list.tsx's own `getSourceInfo` when it can render
 * something, falling back to the engine's own pool-summary label
 * (`sourceLabel`) as plain text otherwise. Two misses need this fallback, not
 * one: the item can be missing from `sim.db` entirely, or (badge vendor, rep,
 * tier-token, and other sources `getSourceInfo` does not model) present in
 * the database but resolved to an empty `<></>` fragment -- `getSourceInfo`
 * returns that empty fragment for real, non-error cases, so its *content*
 * has to be checked, not just whether the lookup itself succeeded.
 * `RankedItem.source` is `upgrades/engine/pool.ts`'s `ItemSource` -- a
 * ranking-pool summary (kind + zone/boss), not the full site `Item` proto
 * `getSourceInfo` reads -- so the two are resolved independently rather than
 * one derived from the other.
 */
function sourceCell(row: Pick<RankedItem, 'itemId' | 'source'>, sim: IndividualSimUI<any>['sim']): Node {
	const item = Database.getSync().getItemById(row.itemId);
	const rendered = item ? getSourceInfo(item, sim) : null;
	if (rendered === null || isEmptyElement(rendered)) return <>{sourceLabel(row.source)}</>;
	return rendered;
}

/**
 * Whether a `JSX.Element` rendered no content -- `getSourceInfo`'s `<></>`
 * cases (no PvP season, no zone, no npc/otherName, no modeled source kind).
 * tsx-vanilla's fragment shorthand has no props to inspect ahead of render,
 * so this checks the one thing that is actually true of every empty case:
 * the DOM node it produces has no children and no text.
 */
function isEmptyElement(node: Node): boolean {
	return node.childNodes.length === 0 && !node.textContent;
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
		case 'simming':
			return i18n.t('upgrades_tab.progress.simming', { done: p.done, total: p.total });
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking');
	}
}
