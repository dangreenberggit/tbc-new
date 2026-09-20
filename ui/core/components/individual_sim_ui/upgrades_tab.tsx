import { Tab } from 'bootstrap';
import tippy, { Instance as TippyInstance } from 'tippy.js';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { CURRENT_API_VERSION } from '../../constants/other.js';
import { setItemQualityCssClass } from '../../css_utils';
import { IndividualSimUI } from '../../individual_sim_ui';
import { Spec } from '../../proto/common.js';
import { SavedGearSet } from '../../proto/ui.js';
import { ActionId } from '../../proto_utils/action_id';
import { Database } from '../../proto_utils/database.js';
import { TypedEvent } from '../../typed_event';
import { BaseModal } from '../base_modal';
import { CopyButton } from '../copy_button';
import { getSourceInfo } from '../gear_picker/item_list';
import { makePhaseSelector } from '../inputs/other_inputs';
import { BooleanPicker } from '../pickers/boolean_picker';
import { NumberPicker } from '../pickers/number_picker';
import { SimTab } from '../sim_tab';
import { BulkHttpSimRunner } from './upgrades/adapters/bulk_http_sim_runner';
import { makeSimRunner } from './upgrades/adapters/bulk_wasm_sim_runner';
import { PlayerGearSource } from './upgrades/adapters/player_gear_source';
import { simDatabaseResolverFor } from './upgrades/adapters/sim_database';
import { currentPageSkeleton } from './upgrades/adapters/skeleton';
import { WorkerPoolSimRunner } from './upgrades/adapters/worker_pool_sim_runner';
import { bisTagPhaseFor, cutoffIsUnmeasuredFor, epWeightsDisclosureFor, epWeightsFor, poolFor, poolSourceFor, unsourcedCountFor } from './upgrades/data/data';
import { type Cutoff,cutoffAdmittingArm, setBonusNoiseFloorDps } from './upgrades/engine/cutoff';
import type { Assumptions } from './upgrades/engine/disclosure';
import { isKaelTempLegendary } from './upgrades/engine/kael-temp';
import { filterPoolByPhase, type ItemSource, type PoolEntry,simSlotsForPoolSlot } from './upgrades/engine/pool';
import { type PartialRanking, type Progress, type RankedItem, type Ranking, type RankInput,rankUpgrades } from './upgrades/engine/rank';
import { MemoryStore } from './upgrades/engine/seams/store';
import { SIM_ORDER, type SimOrderName } from './upgrades/engine/slots';
import type { ContentPhase, SpecId } from './upgrades/engine/types';
import { applyView, rankableSetPotential, SOURCE_LABELS, type ViewOptions, type ViewResult, type ViewRow } from './upgrades/engine/view';
import { ENGINE_FORK_COMMIT } from './upgrades/engine_provenance';

/**
 * Specs this tab can rank, per plan §2.5: "The tab renders only for specs
 * with universe data (ret, feral)." `Spec.SpecFeralCatDruid` is the DPS
 * feral spec (`proto/common.ts`) — `Spec.SpecFeralBearDruid` (tank) is a
 * different `DetectedSpecId` value the engine never produces here (see
 * engine/types.ts's doc comment on `DetectedSpecId`).
 */
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
	private enabled = true;
	private readonly emitter = new TypedEvent<void>();
	private readonly picker: BooleanPicker<ViewToggle>;
	private readonly qualifierElem?: HTMLElement;
	private readonly tip?: TippyInstance;
	private readonly baseTooltip?: string;

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
			extraCssClasses: config.extraCssClasses,
			inline: true,
			// `update()` re-reads this to add/remove `.disabled` and the input's
			// `disabled` attribute (input.tsx:105-115); `setEnabled` flips the flag
			// then calls `update()` so a run with no rankable set bonus can show the
			// toggle disabled rather than hiding it (ticket 441).
			enableWhen: () => this.enabled,
			changedEvent: () => this.emitter,
			getValue: () => this.value,
			setValue: (_eventID, _obj, newValue) => {
				this.value = newValue;
				config.onChange();
			},
		});
		// The tooltip hangs off the picker's `.form-check` root, not its
		// `<label>` (ticket 420): `Input` attaches `labelTooltip` to the label
		// alone (input.tsx:91-93), so hovering the checkbox showed nothing. The
		// whole checkbox+label wrapper is one hover region here instead. The
		// instance handle is kept (F4) so `setEnabled` can swap the content to a
		// "why disabled" reason and restore the base text on re-enable.
		this.baseTooltip = config.labelTooltip;
		if (config.labelTooltip) {
			// `tippy` with a single element reference returns one `Instance`; the
			// declared return is a union with the array form, so it is narrowed here.
			this.tip = tippy(this.picker.rootElem, { content: config.labelTooltip }) as TippyInstance;
		}
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

	/**
	 * Enable or disable the toggle in place (ticket 441). Disabling keeps the
	 * control visible — the native `Input.update()` adds `.disabled` and the
	 * input's `disabled` attribute (input.tsx:105-115) — and, when a `reason` is
	 * given, swaps the hover tooltip to it so the reader learns why. Disabling
	 * also forces the value off through `update()`'s value sync, so a stale "on"
	 * from a previous run cannot silently hide rows. Re-enabling restores the
	 * base tooltip text.
	 */
	setEnabled(enabled: boolean, reason?: string): void {
		this.enabled = enabled;
		if (!enabled) this.value = false;
		this.picker.update();
		if (this.tip) {
			this.tip.setContent(!enabled && reason ? reason : this.baseTooltip ?? '');
		}
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
 * The status-line message for a failed run (ticket 437). A worker/WASM load
 * failure surfaced the raw "Ranking failed: Failed to fetch" — the browser
 * `fetch` `TypeError` from an unreachable sim worker (worker_pool.ts:47), or
 * `worker_pool.ts:49`'s own "Failed to fetch sim wasm module: HTTP …" — which
 * reads like a crash to a user who has no concept of a worker or a server.
 * Both origins start their message with "Failed to fetch", so that prefix is the
 * whole test: the browser `fetch` `TypeError` is `"Failed to fetch"` and
 * `worker_pool.ts:49` is `"Failed to fetch sim wasm module: HTTP …"`. Matching on
 * the whole `TypeError` class would be wrong -- `run()` wraps the entire ranking
 * pipeline (fetch, sim, result parse, row assembly), so a downstream bug that
 * throws a `TypeError` (a null-deref while reading a result) would be relabelled
 * "refresh the page", advice that re-hits the same deterministic bug. That error
 * keeps "Ranking failed: {{message}}" so its message still shows; the raw cause
 * is `console.error`'d at the call site regardless.
 */
function describeRunError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.startsWith('Failed to fetch')) {
		return i18n.t('upgrades_tab.status.error_sim_unavailable');
	}
	return i18n.t('upgrades_tab.status.error', { message });
}

/**
 * The content-source key a pool entry files under -- its first zone, else its
 * `SOURCE_LABELS` bucket. Mirrors engine/view.ts's module-private `sourcesOf`
 * (view.ts:58-60) and `zoneKeyOf` (view.ts:87-92) over a `PoolEntry` instead of
 * a `RankedItem`; both carry the same `ItemSource` `source`/`sources` shape
 * (C30), and the engine helpers are not exported and the engine dir is
 * byte-gated, so this is a transcription, not an import. If those change, this
 * must change with them.
 */
function poolSourcesOf(entry: PoolEntry): readonly ItemSource[] {
	return entry.sources ?? [entry.source];
}

function sourceKeyOf(entry: PoolEntry): string {
	for (const s of poolSourcesOf(entry)) {
		if ('zone' in s) return s.zone;
	}
	return SOURCE_LABELS[entry.source.kind] ?? entry.source.kind;
}

/**
 * Whether a pool entry belongs to the given source key. Mirrors
 * engine/view.ts's module-private `matchesZone` (view.ts:62-64) and
 * `matchesRaidFilter` (view.ts:117-121): a zone matches any source carrying that
 * zone; a zoneless bucket matches only an entry with no zone whose bucket key
 * equals it.
 */
function sourceMatches(entry: PoolEntry, key: string): boolean {
	const sources = poolSourcesOf(entry);
	if (sources.some(s => 'zone' in s && s.zone === key)) return true;
	return sourceKeyOf(entry) === key && !sources.some(s => 'zone' in s);
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
function resultsSortKey(column: ResultsSortColumn, row: ViewRow, deltaKey: (row: ViewRow) => number): string | number {
	switch (column) {
		case 'item':
			return row.name.toLowerCase();
		case 'slot':
			return slotLabel(effectiveSlot(row)).toLowerCase();
		case 'delta_dps':
			// The DPS column sorts on whatever figure the cell shows. With set
			// potential on, the cell shows `deltaDps + rankableSetPotential`
			// (ticket 419), so the header sort must key on the same total or a
			// click would reorder the rows away from the numbers on screen (C28).
			// `deltaKey` carries that choice from the caller, which knows the
			// toggle state and the per-spec floor.
			return deltaKey(row);
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
function sortRows(rows: readonly ViewRow[], sort: ResultsSort, deltaKey: (row: ViewRow) => number): ViewRow[] {
	const dir = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const ak = resultsSortKey(sort.column, a, deltaKey);
		const bk = resultsSortKey(sort.column, b, deltaKey);
		if (ak === bk) return 0;
		return ak < bk ? -dir : dir;
	});
}

/**
 * A gear set the user can guarantee into the sim (ticket 424): a phase-BiS
 * preset or a saved gear set, reduced to the item ids it contains so a result
 * row's membership is an exact id test. `phase` is the preset's numeric `Phase`
 * (absent for saved sets, which carry none); `label` is the chip's display text
 * ("P3 - BiS 9%"); `name` is the bare set name ("BiS 9%") the gear tab shows,
 * used as a result row's tag (ticket 430) rather than the phase-prefixed label.
 */
type GuaranteedSet = { key: string; label: string; name: string; phase?: number; itemIds: Set<number> };

export class UpgradesTab extends SimTab {
	readonly simUI: IndividualSimUI<any>;

	protected shoppingListElem: HTMLElement;
	protected settingsCardElem: HTMLElement;
	protected viewControlsHostElem: HTMLElement;
	/** The pre-run explanation paragraph, hidden by `render()` once a run leaves idle (ticket 461). */
	protected descriptionElem!: HTMLElement;
	/** The view-controls row, so `render()` can hide its title pre-run (ticket 415). */
	protected viewControlsElem!: HTMLElement;
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
	/** The source-filter modal's body -- where `refreshSourceFilter` builds the grouped checkboxes (tickets 417/447). */
	protected sourcesGroupElem!: HTMLElement;
	/** The "Sources…" button and the exclusion-summary line under it (ticket 447). */
	protected sourcesButtonElem!: HTMLButtonElement;
	protected sourcesSummaryElem!: HTMLElement;
	/** The `BaseModal` the button opens; the checkboxes live in its body (ticket 447). */
	protected sourcesModal!: BaseModal;
	// Content-source EXCLUSIONS, applied to the candidate pool before the sim
	// (ticket 417). Stored as exclusions so the default -- an empty set -- means
	// "every source on", and a source that first appears after a phase change is
	// on by default rather than silently excluded. Page-session state like the
	// BiS prune, not persisted.
	private excludedSources = new Set<string>();
	/** The set-guarantee chip group's mount for the always-shown chips (ticket 424). */
	protected setsGroupElem!: HTMLElement;
	/** The "Other phases (n)" disclosure toggle and its off-phase chip mount (ticket 448). */
	protected setsMoreToggleElem!: HTMLButtonElement;
	protected setsMoreElem!: HTMLElement;
	// Whether the off-phase disclosure is open. Kept on the instance, not the DOM,
	// so it survives the refreshSetChips rebuilds that fire on every tab show and
	// settings change (ticket 448); default collapsed each page load.
	private otherPhasesOpen = false;
	/** The set-guarantee caption, whose cap note appears when a cap is set (ticket 424). */
	protected setsCaptionElem!: HTMLElement;
	// Keys of the gear sets whose items are kept in the pool whatever the filters
	// say (ticket 424). Page-session state; the run captures nothing extra, it
	// just unions these back into `effectivePool`.
	private guaranteedSetKeys = new Set<string>();
	// The specId:maxPhase the current default selection was resolved for (ticket
	// 433). refreshSetChips re-applies the universe-BiS default only when this
	// changes, so a user untick survives a gear-change refresh but a phase or
	// spec change re-resolves to the new phase's default.
	private defaultSetsScope: string | undefined;
	protected statusElem!: HTMLElement;
	/** Last kind written to a live region, so a re-render within one state stays silent. */
	private announcedKind: RunState['kind'] | undefined;
	protected statusAnnounceElem!: HTMLElement;
	protected errorAlertElem!: HTMLElement;
	protected resultsElem!: HTMLElement;
	/** The baseline-summary element under the ranked table (ticket 416). */
	protected baselineSummaryElem!: HTMLElement;
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
	// The export flavour picker's own change channel (ticket 422). A bare
	// `TypedEvent`, exactly as the run-settings pickers bind to their fields, so
	// the `BooleanPicker` re-syncs its display from `exportTokenFlavour`.
	private readonly exportFlavourChangedEmitter = new TypedEvent<void>();

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
	// Both transports use this runner: `simRunner()` below returns it
	// unconditionally (ticket 403).
	//
	// It is called with bulk screening OFF, so this runner has no
	// `runBulkScreen` and `rankUpgrades` takes its per-candidate path unchanged.
	private readonly sim = makeSimRunner();
	// Memoised so the transport is probed once per tab, not once per run, and so
	// two runs never hold different runners (each runner owns worker pools).
	private simRunnerPromise: Promise<WorkerPoolSimRunner | BulkHttpSimRunner> | undefined;
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
		const descriptionRef = ref<HTMLParagraphElement>();

		this.contentContainer.appendChild(
			<>
				<div className="upgrades-tab-left tab-panel-left">
					{/*
					 * The pre-run explanation, mirroring the Batch tab's own
					 * `<p className="mb-0" innerHTML={bulk_tab.description}>`
					 * (`bulk_tab.tsx:482`, ticket 461). First child of the left
					 * panel so it reads before the controls; hidden by `render()`
					 * once a run leaves the idle state, since the results below it
					 * then say what the tab does.
					 */}
					<p ref={descriptionRef} className="upgrades-description mb-0" innerHTML={i18n.t('upgrades_tab.description')} />
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
		this.descriptionElem = descriptionRef.value!;
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

		// Re-read the always-sim set chips when this top-level tab is shown (ticket
		// 424, C33): a saved gear set created on the Gear tab after this tab was
		// built is only in localStorage, so refreshing on show picks it up.
		// `SimTab.navLink` is the tab's own nav button, which Bootstrap fires
		// `shown.bs.tab` on when the tab is switched to.
		this.navLink.addEventListener('shown.bs.tab', () => this.refreshSetChips());
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
		const viewControlsRef = ref<HTMLDivElement>();
		const setPotentialPickerRef = ref<HTMLDivElement>();
		const bisOnlyPickerRef = ref<HTMLDivElement>();
		const sourcesButtonRef = ref<HTMLButtonElement>();
		const sourcesSummaryRef = ref<HTMLParagraphElement>();
		const setsGroupRef = ref<HTMLDivElement>();
		const setsMoreToggleRef = ref<HTMLButtonElement>();
		const setsMoreRef = ref<HTMLDivElement>();
		const setsCaptionRef = ref<HTMLParagraphElement>();
		const phaseSelectorRef = ref<HTMLDivElement>();
		const statusRef = ref<HTMLDivElement>();
		const statusAnnounceRef = ref<HTMLDivElement>();
		const errorAlertRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();
		const baselineSummaryRef = ref<HTMLDivElement>();
		const substitutionsHostRef = ref<HTMLDivElement>();
		const exportBoxRef = ref<HTMLDivElement>();
		const exportAreaRef = ref<HTMLTextAreaElement>();
		const exportCountRef = ref<HTMLSpanElement>();
		const exportCopyHostRef = ref<HTMLSpanElement>();
		const exportFlavourPickerRef = ref<HTMLDivElement>();
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
						{/*
						 * The Content source filter (ticket 417) narrows the candidate
						 * pool BEFORE the sim. Ticket 447 moved it out of a flat checkbox
						 * stack -- which stood ~43% of the settings card and pushed the
						 * primary action down the phone screen -- into the native wowsims
						 * filters idiom: a "Sources…" button opening a `BaseModal` of
						 * grouped 2-col checkboxes (the same control the gear picker uses
						 * to filter items by source), plus a one-line summary that keeps
						 * the exclusion state visible without opening the modal. The block,
						 * button and summary stay in this `.content-block`; the checkboxes
						 * are built into the modal body by `refreshSourceFilter()`. Each
						 * checkbox row still carries `data-source` so ticket 418's
						 * per-profession gate can attach a companion control.
						 */}
						<div className="upgrades-source-filter-group content-block">
							<div className="content-block-header">
								<h6 className="content-block-title">{i18n.t('upgrades_tab.settings.sources_title')}</h6>
							</div>
							<div className="content-block-body">
								<button ref={sourcesButtonRef} type="button" className="btn btn-outline-primary upgrades-sources-button">
									{i18n.t('upgrades_tab.settings.sources_button')}
								</button>
								<p ref={sourcesSummaryRef} className="form-text upgrades-text-secondary upgrades-sources-summary mt-1" />
							</div>
						</div>
						{/*
						 * The always-sim gear sets, titled "Sim sets" (tickets 424/429):
						 * a chip per phase-BiS preset and saved gear set; a selected set's
						 * items stay in the pool whatever the source/prune filters above
						 * say, and matching result rows carry the set's name as a tag.
						 * Same `.content-block` wrap as the Content filter (428) so the
						 * title reads bold with a bottom rule. Chips are the gear tab's own
						 * `saved-data-set-chip` markup (a padded inner
						 * `.saved-data-set-name` span, C10) toggled as a multi-select. The
						 * caption is site `form-text` size (429), tinted with this tab's
						 * `--bs-gray-500` secondary colour rather than form-text's
						 * AA-failing gray-600 (C22).
						 */}
						<div className="upgrades-set-guarantee-group content-block">
							<div className="content-block-header">
								<h6 className="content-block-title">{i18n.t('upgrades_tab.settings.sets_title')}</h6>
							</div>
							<div className="content-block-body">
								<div ref={setsGroupRef} className="upgrades-set-guarantee" />
								{/* Off-phase preset chips collapse behind this disclosure (ticket
								    448). The button + collapse class is the tab's own idiom, not
								    <details> (the run-settings note above records why <details>
								    measured broken); it collapses at every width, so its SCSS omits
								    the run-settings media wrap. */}
								<button ref={setsMoreToggleRef} type="button" className="upgrades-set-more-summary d-none" attributes={{ 'aria-expanded': 'false' }} />
								<div ref={setsMoreRef} className="upgrades-set-guarantee upgrades-set-more d-none" />
								<p ref={setsCaptionRef} className="form-text upgrades-set-guarantee-caption upgrades-text-secondary" />
							</div>
						</div>
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
			<div ref={viewControlsRef} className="upgrades-view-controls">
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
				 * The baseline summary (ticket 416): "Your current gear: N DPS. Took
				 * Ns." moved out of the top status line to sit directly under the
				 * ranked table, so a reader gets the ranking first and the current-gear
				 * figure as a footer rather than a header. Permanent in the DOM;
				 * `baselineSummaryContent()` fills it on every render and leaves it
				 * empty except in the done/stopped states.
				 */}
				<div ref={baselineSummaryRef} className="upgrades-baseline-summary upgrades-status-line" />
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
					 * ids. A native `BooleanPicker` (`inline: true`) rather than the
					 * hand-rolled `<label><input>` (ticket 422): the site's own
					 * checkbox row spaces the box from its text, the gap the
					 * hand-rolled markup lacked. It changes the export FORMAT, not the
					 * ranking or which rows show.
					 */}
					<div ref={exportFlavourPickerRef} className="upgrades-export-flavour" />
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

		this.viewControlsElem = viewControlsRef.value!;
		this.eligibleCountElem = eligibleCountRef.value!;
		this.runButton = runButtonRef.value!;
		this.stopButton = stopButtonRef.value!;
		// A view option, not a run input: `onChange` re-renders, applying the
		// toggle to the ranking already in hand and dispatching no sim. The
		// picker's own `change` listener carries this through `setValue`, so no
		// manual `change` listener is wired below.
		//
		// The set-potential toggle needs an explanation of what it does to the
		// ranking (ticket 328 item 4). `ViewToggle` attaches the site's tippy to
		// the picker's `.form-check` root, so the whole checkbox+label wrapper is
		// the hover target rather than the label alone (ticket 420).
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
		this.sourcesButtonElem = sourcesButtonRef.value!;
		this.sourcesSummaryElem = sourcesSummaryRef.value!;
		// The source checkboxes now live in a native filters modal (ticket 447)
		// rather than a stack in the card. `filters-menu` on the dialog reuses the
		// gear picker's 2-col grid and section spacing (no new SCSS). The modal is
		// parented to the tab root (`#upgrades-tab`), not the settings card: the
		// card sits in `.upgrades-settings-outer-container`, which is
		// `position: sticky` and so establishes a stacking context, and the sticky
		// header (`z-index: 100`) is that context's sibling -- inside the card the
		// dialog's `z-index: 1055` is ranked against the card's own auto level, so
		// header items painted over it (ticket 458). The tab root is not a stacking
		// context, and it is still inside the tab's axe scope the 447 note wanted,
		// matching the Batch tab, which parents its modal to `simUI.rootElem`
		// (`bulk_tab.tsx:182`).
		this.sourcesModal = new BaseModal(this.rootElem, 'filters-menu', {
			size: 'md',
			title: i18n.t('upgrades_tab.settings.sources_title'),
			disposeOnClose: false,
		});
		this.sourcesModal.rootElem.classList.add('upgrades-sources-modal');
		this.sourcesGroupElem = this.sourcesModal.body;
		this.sourcesButtonElem.addEventListener('click', () => this.sourcesModal.open());
		this.setsGroupElem = setsGroupRef.value!;
		this.setsMoreToggleElem = setsMoreToggleRef.value!;
		this.setsMoreElem = setsMoreRef.value!;
		this.setsCaptionElem = setsCaptionRef.value!;
		this.statusElem = statusRef.value!;
		this.statusAnnounceElem = statusAnnounceRef.value!;
		this.errorAlertElem = errorAlertRef.value!;
		this.resultsElem = resultsRef.value!;
		this.baselineSummaryElem = baselineSummaryRef.value!;
		this.substitutionsHostElem = substitutionsHostRef.value!;
		this.exportBoxElem = exportBoxRef.value!;
		this.exportAreaElem = exportAreaRef.value!;
		// The payload is generated, never typed into; set as a property because
		// the JSX `attributes` map does not carry `readonly`.
		this.exportAreaElem.readOnly = true;
		this.exportCountElem = exportCountRef.value!;
		this.exportFlavourCaptionElem = exportFlavourCaptionRef.value!;

		// The token/gear-id flavour toggle (ticket 126, ticket 422). A native
		// `BooleanPicker` (`inline: true`) so the checkbox and its label carry the
		// site's own spacing rather than the hand-rolled `<label><input>`'s. A
		// change re-renders, which recomputes the payload through `updateExport`
		// with the new flavour and repaints the caption — the same render-on-change
		// pattern the view toggles use, but this one touches only the export format.
		new BooleanPicker<UpgradesTab>(exportFlavourPickerRef.value!, this, {
			id: 'upgrades-export-flavour',
			label: i18n.t('upgrades_tab.export.flavour_toggle'),
			inline: true,
			changedEvent: _ => this.exportFlavourChangedEmitter,
			getValue: _ => this.exportTokenFlavour,
			setValue: (eventID, _obj, newValue: boolean) => {
				this.exportTokenFlavour = newValue;
				this.exportFlavourChangedEmitter.emit(eventID);
				this.render();
			},
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
		// The upstream EnumPicker renders a bare <select> with no name (ticket 445,
		// axe select-name). We don't edit the upstream widget; name it from our side
		// after it mounts into our own container.
		phaseSelectorRef.value!.querySelector('select')?.setAttribute('aria-label', i18n.t('upgrades_tab.settings.phase_label'));

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
				// `describeRunError` returns the display-ready line: a plain
				// engine-unreachable sentence for a worker/WASM load failure
				// (ticket 437), else the wrapped "Ranking failed: {{message}}". The
				// raw cause stays diagnosable in the console.
				console.error(err);
				this.setState({ kind: 'error', message: describeRunError(err) });
			});
		});

		// The two view toggles re-render on change through their picker's own
		// `setValue` (`onChange: () => this.render()` at construction), so no
		// manual `change` listener is wired for them here. The Content source
		// filter is now a pre-sim run input (ticket 417), so it lives in the run
		// settings and its pickers refresh the pool through their own `setValue`,
		// not a view-controls listener here.
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

		// The off-phase Sim-sets disclosure (ticket 448), same button-plus-class
		// idiom. The open state lives on the instance so refreshSetChips can restore
		// it after a rebuild; this handler flips it and mirrors the DOM.
		this.setsMoreToggleElem.addEventListener('click', () => {
			this.otherPhasesOpen = !this.otherPhasesOpen;
			this.setsMoreElem.classList.toggle('upgrades-set-more--open', this.otherPhasesOpen);
			this.setsMoreToggleElem.setAttribute('aria-expanded', String(this.otherPhasesOpen));
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
		// Rebuild the source checkboxes for the current spec/phase (ticket 417),
		// before the count is read so a spec/phase change's option set is live.
		// A source picker's OWN change never routes here (it calls
		// updateEligibleCount instead), so this never rebuilds a picker mid-event.
		this.refreshSourceFilter();
		// The always-sim set chips follow spec/phase the same way (ticket 424); a
		// chip's own click updates the count directly, so this is not re-entered.
		this.refreshSetChips();
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
		this.updateEligibleCount();
	}

	/**
	 * Writes the eligible count into the readout and the Candidates placeholder,
	 * without rebuilding any control. Split from `refreshCandidatesPlaceholder`
	 * (ticket 417) so a source checkbox can update the count from inside its own
	 * change handler without `replaceChildren`-ing the group it lives in.
	 */
	private updateEligibleCount(): void {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		if (!specId) {
			this.setCandidatesPlaceholder(i18n.t('upgrades_tab.candidates_placeholder_uncapped'));
			this.eligibleCountElem.textContent = i18n.t('upgrades_tab.eligible_count_unknown');
			return;
		}
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
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
		// Content-source filter (ticket 417): keep only entries whose source is
		// still ticked. Computed alongside the BiS prune at the one place both
		// callers (`eligibleCount` and `run`) go through, so the eligible count
		// and the pool the run actually sims stay equal. An entry is kept unless
		// its source key is excluded, so an empty exclusion set is a no-op.
		const options = this.sourceOptions(specId, maxPhase);
		const sourceKept = (e: PoolEntry) => options.some(key => !this.excludedSources.has(key) && sourceMatches(e, key));
		const filtered = pool.filter(e => (!pruned || isBisTagged(e)) && sourceKept(e));
		// Always-sim sets (ticket 424): union back every pool entry whose itemId is
		// in a selected set, regardless of the prune and source filters above. A
		// set item absent from this phase's pool cannot be added (no PoolEntry
		// exists for it), which is the disabled-chip limit the UI states. Deduped
		// by itemId+slot so a source-kept entry is not doubled.
		const guaranteed = this.guaranteedItemIds();
		if (guaranteed.size === 0) return filtered;
		const seen = new Set(filtered.map(e => `${e.itemId}:${e.slot}`));
		const unioned = [...filtered];
		for (const e of pool) {
			if (!guaranteed.has(e.itemId)) continue;
			const dedupe = `${e.itemId}:${e.slot}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			unioned.push(e);
		}
		return unioned;
	}

	/**
	 * The desktop transport uses the per-candidate loop, not the Go bulk RPC.
	 * Bulk screening measured 263 s against 19 s at cap 40 (ticket 403); its
	 * finalist stage refines every candidate because `topResults` must equal the
	 * chunk size. `BulkHttpSimRunner` stays in the tree — see 403 before re-enabling.
	 *
	 * The `upgradesTab.runner` localStorage key exists only for ticket 411's
	 * measurement harness: set to `bulk-http` it selects the Go bulk runner so the
	 * two transports can be timed side by side. The default (no key, any other
	 * value, or a storage throw) is the loop, so the shipped path is unchanged.
	 */
	private simRunner(): Promise<WorkerPoolSimRunner | BulkHttpSimRunner> {
		this.simRunnerPromise ??= (async () => {
			try {
				if (window.localStorage.getItem('upgradesTab.runner') === 'bulk-http') {
					return new BulkHttpSimRunner(this.sim.concurrency);
				}
			} catch {
				// Storage unavailable (private mode, blocked): fall through to the default loop.
			}
			return this.sim;
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
		// Desktop-gate S1: cleared here so a read of `data-runner` after any run
		// reflects that run's transport choice and never a stale prior value.
		this.statusElem.removeAttribute('data-runner');
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
		// Desktop-gate S1: record the runner class the tab actually chose. A
		// literal keyed on `instanceof`, not `constructor.name` — Vite minifies
		// class names in production, so the name is unusable; the literal is not.
		this.statusElem.setAttribute('data-runner', sim instanceof BulkHttpSimRunner ? 'BulkHttpSimRunner' : 'WorkerPoolSimRunner');

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
					// `min(workers, memoryCap)` — WorkerPoolSimRunner derives this once at
					// construction from the measured per-process memory cost
					// (candidate-pool.md §5.1.2, worker_pool_sim_runner.ts).
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
		// Pre-run there is nothing to filter and no results to sub-tab, so the
		// "View options" heading and the lone "Shopping List" tab strip would be
		// empty labels (ticket 415). Hide the title's ink (its 2.25rem row still
		// reserves height, so nothing shifts when results arrive -- C24) and drop
		// the nav out of flow until a run is done. `.upgrades-tab-tabs` itself
		// stays in the DOM because the layout gate measures it (C24).
		const done = this.state.kind === 'done';
		// The pre-run explanation is only for the idle state; once a run starts
		// the results and status below say what the tab is doing (ticket 461).
		this.descriptionElem.classList.toggle('d-none', this.state.kind !== 'idle');
		this.viewControlsElem.classList.toggle('upgrades-view-controls--empty', !done);
		this.tabNavElem.classList.toggle('d-none', !done);
		this.refreshViewControlVisibility();
		// Hidden up front on every render; the shortlist path shows it again
		// when it has rows to export. A state with no shortlist -- running,
		// error, or a run that cleared the cutoff with nothing -- therefore
		// leaves no stale payload on screen.
		setControlVisible(this.exportBoxElem, false);
		this.statusElem.replaceChildren(this.statusContent());
		// Filled before `renderAnnouncement` reads it: the done/stopped summary
		// now lives in this element rather than the top status line, so the live
		// region announces its text (ticket 416).
		this.baselineSummaryElem.replaceChildren(this.baselineSummaryContent());
		this.renderSubTabs();
		// Announce AFTER the results host is populated (ticket 427, F5): the idle /
		// unsupported-spec text now lives only in the empty state that
		// `renderSubTabs` writes, so announcing before it exists would speak "".
		this.renderAnnouncement();
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

		// The done/stopped summary moved to `baselineSummaryElem` (ticket 416) and
		// the idle / unsupported-spec purpose moved to the empty state (ticket 427),
		// so the announced text is read from wherever the state's copy now lives --
		// reading the now-blank top status line would announce nothing (C27, F5).
		// The top line still carries the announcement for running and the stale
		// warning.
		let announceSource: HTMLElement;
		if (kind === 'done' || kind === 'stopped') {
			announceSource = this.baselineSummaryElem;
		} else if (kind === 'idle' || kind === 'unsupported-spec') {
			announceSource = this.resultsElem.querySelector<HTMLElement>('.upgrades-empty-state') ?? this.statusElem;
		} else {
			announceSource = this.statusElem;
		}
		// `state.message` is already the display-ready line from `describeRunError`
		// (ticket 437), so it is not re-wrapped in `status.error` here.
		const message = kind === 'error' ? this.state.message : (announceSource.textContent?.trim() ?? '');
		const isError = kind === 'error';
		this.errorAlertElem.replaceChildren(isError ? message : '');
		this.statusAnnounceElem.replaceChildren(isError ? '' : message);
	}

	private statusContent(): Node {
		switch (this.state.kind) {
			case 'idle':
			case 'unsupported-spec':
				// The pre-run purpose and the Run CTA live in the centred empty
				// state (`resultsContent`, ticket 427) so the tab says why it
				// exists exactly once. The top status slot stays blank here; its
				// `.upgrades-status` min-height reserves the row so nothing shifts
				// when a run fills it (C18). The idle top-line key is no longer
				// rendered but stays in the locale and schema (still required, C25a);
				// ticket 432 decides its long-term fate. The empty state draws its
				// own copy from `results.empty_no_ranking(_body)` and, for
				// unsupported specs, the top-line unsupported key plus
				// `results.empty_unsupported_spec_body`.
				return <></>;
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
				// `state.message` is the display-ready line from `describeRunError`
				// (ticket 437), already wrapped or plain as appropriate.
				return <div className="upgrades-status-line text-danger">{this.state.message}</div>;
			case 'stopped':
				// The stopped baseline moved under the table (ticket 416); the top
				// status line has nothing left to say for this state.
				return <></>;
			case 'done':
				// The done baseline ("Your current gear: N DPS. Took Ns.") moved
				// under the table (ticket 416). Only the staleness warning stays in
				// the top slot, because it is a caution about the results the reader
				// is about to act on, not a footer summarising them.
				return this.state.stale ? (
					<div className="upgrades-status-line text-warning">
						<strong>{i18n.t('upgrades_tab.status.stale')}</strong>
					</div>
				) : (
					<></>
				);
		}
	}

	/**
	 * The current-gear baseline, under the ranked table (ticket 416): "Your
	 * current gear: N DPS. Took Ns." for a completed run, the stopped-early
	 * variant for a Stop. Empty in every other state. Rendered into
	 * `baselineSummaryElem` (which already carries `.upgrades-status-line`) on
	 * every `render()`, before `renderAnnouncement` reads its text. The
	 * stopped-early tone is a warning, so `.text-warning` is toggled on the host
	 * rather than being a nested line.
	 */
	private baselineSummaryContent(): Node {
		const stopped = this.state.kind === 'stopped';
		this.baselineSummaryElem.classList.toggle('text-warning', stopped);
		switch (this.state.kind) {
			case 'stopped': {
				// No elapsed figure on a stopped run: the "Took Ns" was a partial
				// wall-clock for a run the user cut short, and reading it as the
				// cost of a full ranking is misleading (ticket 460).
				const label = i18n.t('upgrades_tab.status.stopped', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return (
					<>
						<span>{label}</span>
					</>
				);
			}
			case 'done': {
				const label = i18n.t('upgrades_tab.status.done', { dps: this.state.ranking.baseline.dps.toFixed(1) });
				return (
					<>
						{label} {this.elapsedContent()}
					</>
				);
			}
			default:
				return <></>;
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
		// aria-value* and the name set imperatively, matching progress_tracker_modal.tsx —
		// this JSX helper's `attributes` type only covers `role` for a bare
		// div, not the aria-value* trio. A progressbar needs a name of its own; the
		// stage text beside it changes each tick, so a stable label is the name
		// (ticket 446, axe aria-progressbar-name).
		barRef.value?.setAttribute('aria-label', i18n.t('upgrades_tab.progress.aria_label'));
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
		// The Set-potential toggle acts on set-bonus sub-lines, so it is meaningless
		// when no row has a rankable set bonus. Rather than vanish after a run
		// (ticket 441 — the owner read the disappearance as a bug), it stays visible
		// and goes disabled with a tooltip saying why. `setEnabled(false)` also
		// forces the value off, so a stale "on" cannot hide rows on the next results.
		const hasRankable = items.some(i => hasRankableSetPotential(i, noiseFloorDps));
		const unavailableReason = i18n.t('upgrades_tab.view.set_potential_unavailable');
		this.setPotentialControl.setVisible(true);
		this.setPotentialControl.setEnabled(hasRankable, unavailableReason);
		this.bisOnlyControl.setVisible(items.some(isBisTagged));
	}

	/**
	 * The content-source options for a spec/phase, zones first then zoneless
	 * buckets, in first-seen order over the pool -- the same split
	 * `raidFilterGroups` makes over ranked rows, but computed over `poolFor`
	 * because the filter now runs pre-sim (ticket 417). `SOURCE_LABELS`'s values
	 * are the zoneless bucket keys; anything else is a zone.
	 */
	private sourceOptions(specId: SpecId, maxPhase: RankInput['maxPhase']): string[] {
		const zoneless = this.zonelessSourceKeys();
		const zones: string[] = [];
		const buckets: string[] = [];
		const seen = new Set<string>();
		for (const entry of poolFor(specId, maxPhase)) {
			const key = sourceKeyOf(entry);
			if (seen.has(key)) continue;
			seen.add(key);
			(zoneless.has(key) ? buckets : zones).push(key);
		}
		return [...zones, ...buckets];
	}

	/**
	 * The zoneless source-bucket keys -- `SOURCE_LABELS`'s values (Badge vendor,
	 * Crafted, Reputation vendor, ...). A key not in this set is a raid zone. Both
	 * `sourceOptions` (order) and `refreshSourceFilter` (the Raids/Other split)
	 * read it, so the taxonomy lives in one place.
	 */
	private zonelessSourceKeys(): Set<string> {
		return new Set(Object.values(SOURCE_LABELS));
	}

	/**
	 * A `menu-section` in the sources modal, built to match the gear picker's
	 * `FiltersMenu.newSection` markup (`filters_menu.tsx:298-309`) so the
	 * `filters-menu` grid rules apply with no new SCSS. `newSection` is private on
	 * `FiltersMenu`, so the markup is copied rather than subclassed (subclassing
	 * would also build the gear picker's own sections). `data-section` lets the
	 * captures and tests target a section by name rather than by position, which
	 * is unstable because an empty section is skipped (C27).
	 */
	private newMenuSection(title: string, sectionKey: string): HTMLElement {
		const section = document.createElement('div');
		section.classList.add('menu-section', `${sectionKey}-section`);
		section.dataset.section = sectionKey;
		section.innerHTML = `
			<div class="menu-section-header">
				<h6 class="menu-section-title"></h6>
			</div>
			<div class="menu-section-content filters-menu-section-bool-list"></div>
		`;
		section.querySelector('.menu-section-title')!.textContent = title;
		this.sourcesGroupElem.appendChild(section);
		return section.querySelector('.menu-section-content') as HTMLElement;
	}

	/**
	 * Rebuilds the Content source checkboxes for the current spec/phase (tickets
	 * 417/447). Called from `refreshCandidatesPlaceholder`, so it follows spec and
	 * phase changes exactly as the eligible-count readout does. The checkboxes are
	 * split into a "Raids" section (zone keys) and an "Other sources" section
	 * (the zoneless `SOURCE_LABELS` buckets), each a `BooleanPicker` in a
	 * `.upgrades-source-row[data-source]` so ticket 418's per-profession gate can
	 * append a companion control. `getValue` reads the negated exclusion set, so a
	 * source is on unless explicitly excluded and a newly-appearing source
	 * defaults on. An empty section is skipped (C27).
	 */
	private refreshSourceFilter(): void {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		this.sourcesGroupElem.replaceChildren();
		if (!specId) {
			this.sourcesButtonElem.disabled = true;
			this.refreshSourcesSummary();
			return;
		}
		this.sourcesButtonElem.disabled = false;
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		const options = this.sourceOptions(specId, maxPhase);
		// Drop exclusions for sources that no longer exist in this spec/phase, so
		// a stale exclusion cannot silently narrow a pool it is invisible in.
		const live = new Set(options);
		for (const key of [...this.excludedSources]) if (!live.has(key)) this.excludedSources.delete(key);

		const zoneless = this.zonelessSourceKeys();
		const raidKeys = options.filter(key => !zoneless.has(key));
		const otherKeys = options.filter(key => zoneless.has(key));
		const addKeysTo = (content: HTMLElement, keys: string[]) => {
			for (const key of keys) {
				const row = (<div className="upgrades-source-row" dataset={{ source: key }} />) as HTMLElement;
				content.appendChild(row);
				new BooleanPicker<UpgradesTab>(row, this, {
					id: `upgrades-source-${key}`,
					label: key,
					inline: true,
					changedEvent: _ => this.settingsChangedEmitter,
					getValue: _ => !this.excludedSources.has(key),
					setValue: (eventID, _obj, newValue: boolean) => {
						if (newValue) this.excludedSources.delete(key);
						else this.excludedSources.add(key);
						// Update the eligible count only -- NOT refreshCandidatesPlaceholder,
						// which rebuilds this very picker group and would destroy the picker
						// whose setValue is running. The option set is unchanged by a tick.
						this.updateEligibleCount();
						this.refreshSourcesSummary();
						this.settingsChangedEmitter.emit(eventID);
						if (this.state.kind === 'done') this.setState({ ...this.state, stale: true });
					},
				});
			}
		};
		if (raidKeys.length) addKeysTo(this.newMenuSection(i18n.t('upgrades_tab.settings.sources_section_raids'), 'raids'), raidKeys);
		if (otherKeys.length) addKeysTo(this.newMenuSection(i18n.t('upgrades_tab.settings.sources_section_other'), 'other'), otherKeys);
		this.refreshSourcesSummary();
	}

	/**
	 * The one-line exclusion summary under the "Sources…" button (ticket 447), so
	 * the filter state reads without opening the modal. Empty and the button
	 * disabled when no spec is selected.
	 */
	private refreshSourcesSummary(): void {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		if (!specId) {
			this.sourcesSummaryElem.textContent = '';
			return;
		}
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		const m = this.sourceOptions(specId, maxPhase).length;
		const n = this.excludedSources.size;
		this.sourcesSummaryElem.textContent =
			n === 0
				? i18n.t('upgrades_tab.settings.sources_summary_none', { m })
				: i18n.t('upgrades_tab.settings.sources_summary', { n, m });
	}

	/**
	 * The gear sets the user can guarantee into the sim (ticket 424): the spec's
	 * phase-BiS presets first, then the saved gear sets under the page's saved-gear
	 * storage key. Presets come straight off `individualConfig.presets.gear` (a
	 * public readonly field) and saved sets are parsed from
	 * `localStorage[getSavedGearStorageKey()]` with `SavedGearSet.fromJson`, the
	 * same read `SavedDataManager.loadUserData` does -- neither crosses the
	 * byte-gated engine boundary or re-implements a set list.
	 *
	 * Label: a preset is `P{phase} - {name}` unless its name already leads with
	 * its P-token (ret's presets are literally "P1"/"P2"/"P3"), in which case the
	 * name stands alone, so ret shows "P2" and "P3 - Bulwark" rather than
	 * "P2 - P2"; a preset with no phase, and every saved set, uses the name.
	 */
	private guaranteedSetsAvailable(): GuaranteedSet[] {
		const sets: GuaranteedSet[] = [];
		const idsOf = (spec: { items: { id: number }[] } | undefined): Set<number> =>
			new Set((spec?.items ?? []).map(i => i.id).filter(id => id > 0));

		for (const preset of this.simUI.individualConfig.presets.gear) {
			const phase = preset.phase as number | undefined;
			// The label leads with "P{phase} - " unless the name already encodes
			// that phase as a leading P-token. `($|[^0-9])` stops "P1" matching a
			// "P12"-style name and, unlike a word-boundary group, does not fail at
			// end-of-string, so a bare "P2" name is kept as-is (not "P2 - P2").
			const encodesPhase = phase !== undefined && new RegExp(`^p${phase}($|[^0-9])`, 'i').test(preset.name);
			const label = phase === undefined || encodesPhase ? preset.name : `P${phase} - ${preset.name}`;
			sets.push({ key: `preset:${phase ?? ''}:${preset.name}`, label, name: preset.name, phase, itemIds: idsOf(preset.gear) });
		}

		try {
			const raw = window.localStorage.getItem(this.simUI.getSavedGearStorageKey());
			if (raw) {
				const stored = JSON.parse(raw) as Record<string, unknown>;
				for (const [name, value] of Object.entries(stored)) {
					try {
						const saved = SavedGearSet.fromJson(value as any);
						sets.push({ key: `saved:${name}`, label: name, name, itemIds: idsOf(saved.gear) });
					} catch {
						// A malformed saved entry is skipped, matching loadUserData.
						console.warn(`[upgrades] skipping malformed saved gear set "${name}"`);
					}
				}
			}
		} catch {
			// localStorage unavailable (private mode, blocked): no saved sets.
		}
		return sets;
	}

	/**
	 * The preset set keys the universe's "BiS" tag speaks for at this spec/phase
	 * (ticket 433) -- the default selection restored on load and on every
	 * spec/phase change, matching what the old yellow "BiS" badge marked.
	 *
	 * A preset qualifies when it leads the phase the tag resolves to
	 * (`bisTagPhaseFor().tagsFromPhase`, which is the newest vendored curated
	 * phase <= maxPhase and can be older than maxPhase when the curated set
	 * degrades) AND every one of its in-pool items is bisTags-tagged, with at
	 * least one in the pool. Both conditions are load-bearing: the id test alone
	 * over-selects (feral P3's ids also satisfy the P4 BiS pair), and the phase
	 * test alone admits same-phase non-BiS presets (feral P3 "Alt", ret P3
	 * "Bulwark"). Saved sets carry no phase and never default.
	 */
	private defaultGuaranteedSetKeys(specId: SpecId, maxPhase: ContentPhase): Set<string> {
		const tagPhase = bisTagPhaseFor(specId, maxPhase)?.tagsFromPhase;
		if (tagPhase === undefined) return new Set<string>();
		const pool = poolFor(specId, maxPhase);
		const poolIds = new Set(pool.map(e => e.itemId));
		const bisIds = new Set(pool.filter(e => e.bisTags?.includes('BiS')).map(e => e.itemId));
		const keys = new Set<string>();
		for (const set of this.guaranteedSetsAvailable()) {
			if (!set.key.startsWith('preset:') || set.phase !== tagPhase) continue;
			const inPool = [...set.itemIds].filter(id => poolIds.has(id));
			if (inPool.length > 0 && inPool.every(id => bisIds.has(id))) keys.add(set.key);
		}
		return keys;
	}

	/**
	 * The item ids kept in the pool by the currently-selected sets (ticket 424),
	 * across every available set whose key is selected. Empty when nothing is
	 * selected, so the union in `effectivePool` is then a no-op.
	 */
	private guaranteedItemIds(): Set<number> {
		const ids = new Set<number>();
		for (const set of this.guaranteedSetsAvailable()) {
			if (!this.guaranteedSetKeys.has(set.key)) continue;
			for (const id of set.itemIds) ids.add(id);
		}
		return ids;
	}

	/**
	 * Rebuilds the always-sim set chips for the current spec/phase (tickets
	 * 424/429). Presets before saved sets; each chip is the gear tab's
	 * `saved-data-set-chip` markup -- the label in a padded inner
	 * `.saved-data-set-name` span (C10) -- and the "n/m in pool" count sits in a
	 * hover tooltip on the button rather than in the chip text. A set with n === 0
	 * is muted (`--unavailable`) and `aria-disabled` but still shown, so the reader
	 * can hover for the reason. Clicking the inner span toggles the key, the
	 * `.active` state and `aria-pressed`, then refreshes the count and marks a done
	 * result stale -- the same run-input behaviour as the source checkboxes. The
	 * caption gains a cap note when a non-zero candidate cap is set and any set is
	 * selected, because the cap still applies engine-side after the union.
	 *
	 * Off-phase preset chips collapse behind an "Other phases (n)" disclosure
	 * (ticket 448). A chip goes in the always-shown row when it is current-phase
	 * (`set.phase === maxPhase`), a saved set (`set.phase === undefined`), or
	 * currently selected; everything else goes behind the disclosure. "Selected"
	 * is a separate clause because a default-selected preset can be off-phase: the
	 * universe BiS tag can resolve to a phase below maxPhase (ticket 433), so
	 * `defaultGuaranteedSetKeys` may pick an off-phase preset that must still show.
	 * Both mount points are cleared and hidden at the top of every rebuild, before
	 * the `!specId` return, because refreshSetChips fires on every tab show and
	 * settings change (C12) -- without the clear the off-phase chips would
	 * duplicate and the "(n)" label would inflate.
	 */
	private refreshSetChips(): void {
		const specId = SPEC_ID_BY_PROTO_SPEC[this.simUI.player.getSpec() as Spec];
		this.setsGroupElem.replaceChildren();
		// Clear + hide the disclosure on every rebuild, before any early return, so
		// no off-phase chip or stale "(n)" survives a spec with no sets (C28).
		this.setsMoreElem.replaceChildren();
		this.setsMoreElem.classList.add('d-none');
		this.setsMoreElem.classList.remove('upgrades-set-more--open');
		this.setsMoreToggleElem.classList.add('d-none');
		if (!specId) {
			this.setsCaptionElem.textContent = '';
			return;
		}
		const maxPhase = this.simUI.sim.getPhase() as RankInput['maxPhase'];
		const poolIds = new Set(poolFor(specId, maxPhase).map(e => e.itemId));
		const sets = this.guaranteedSetsAvailable();
		// Drop selections for sets no longer offered, so a stale key cannot keep
		// unioning items invisibly.
		const liveKeys = new Set(sets.map(s => s.key));
		for (const key of [...this.guaranteedSetKeys]) if (!liveKeys.has(key)) this.guaranteedSetKeys.delete(key);

		// Restore the universe-BiS default whenever the spec/phase changes (ticket
		// 433). The scope guard runs the default once per specId:maxPhase, so a
		// user untick survives the gear-change refreshes that also reach here (C39),
		// while a phase or spec change re-resolves to the new phase's default.
		const scope = `${specId}:${maxPhase}`;
		if (scope !== this.defaultSetsScope) {
			this.guaranteedSetKeys = this.defaultGuaranteedSetKeys(specId, maxPhase as ContentPhase);
			this.defaultSetsScope = scope;
		}

		let hidden = 0;
		for (const set of sets) {
			const inPool = [...set.itemIds].filter(id => poolIds.has(id)).length;
			const total = set.itemIds.size;
			// A set with nothing in this phase's pool cannot be picked, but it stays
			// visible and muted rather than hidden (unlike the manager's `.disabled`,
			// C21) so the reader can see the "0/m in pool" reason on hover. It is
			// `aria-disabled` rather than a real `disabled` button so the tippy still
			// opens and the chip keeps the gear-tab markup; the click handler bails.
			const unavailable = inPool === 0;
			const active = this.guaranteedSetKeys.has(set.key);
			const nameRef = ref<HTMLSpanElement>();
			const chip = (
				<button
					type="button"
					className={`saved-data-set-chip badge rounded-pill upgrades-set-chip${active ? ' active' : ''}${unavailable ? ' upgrades-set-chip--unavailable' : ''}`}
					attributes={{ 'aria-pressed': active ? 'true' : 'false', ...(unavailable ? { 'aria-disabled': 'true' } : {}) }}>
					<span className="saved-data-set-name" attributes={{ role: 'button' }} ref={nameRef}>
						{set.label}
					</span>
				</button>
			) as HTMLButtonElement;
			// Count moves off the chip text into a hover tooltip on the button (429),
			// matching the gear chip's tippy-on-the-button idiom (C10, C26).
			tippy(chip, { content: i18n.t('upgrades_tab.settings.sets_in_pool', { n: inPool, m: total }) });
			nameRef.value!.addEventListener('click', () => {
				if (unavailable) return;
				if (this.guaranteedSetKeys.has(set.key)) this.guaranteedSetKeys.delete(set.key);
				else this.guaranteedSetKeys.add(set.key);
				const nowActive = chip.classList.toggle('active');
				chip.setAttribute('aria-pressed', String(nowActive));
				// Count only, not refreshCandidatesPlaceholder -- that rebuilds this
				// chip group and would drop the button mid-click.
				this.updateEligibleCount();
				this.refreshSetsCaption();
				this.settingsChangedEmitter.emit(TypedEvent.nextEventID());
				if (this.state.kind === 'done') this.setState({ ...this.state, stale: true });
				// Ticking/unticking does NOT move the chip between rows now -- that
				// would rebuild the group mid-click and drop this very button (the
				// count-only reason above). A newly-ticked off-phase chip stays behind
				// the disclosure, a newly-unticked one stays in the main row, until the
				// next refreshSetChips (a tab show or spec/phase change) re-sorts them.
			});
			// Current-phase or saved chips, and any selected chip, sit in the always-
			// shown row; the rest go behind the "Other phases (n)" disclosure (448).
			const visible = set.phase === undefined || set.phase === maxPhase || this.guaranteedSetKeys.has(set.key);
			if (visible) {
				this.setsGroupElem.appendChild(chip);
			} else {
				this.setsMoreElem.appendChild(chip);
				hidden++;
			}
		}
		// Show the disclosure only when something is behind it; keep its open state
		// across rebuilds from the instance flag, not the DOM (C12).
		if (hidden > 0) {
			this.setsMoreToggleElem.classList.remove('d-none');
			this.setsMoreElem.classList.remove('d-none');
			this.setsMoreToggleElem.textContent = i18n.t('upgrades_tab.settings.sets_other_phases', { n: hidden });
			this.setsMoreToggleElem.setAttribute('aria-expanded', String(this.otherPhasesOpen));
			this.setsMoreElem.classList.toggle('upgrades-set-more--open', this.otherPhasesOpen);
		}
		this.refreshSetsCaption();
	}

	/**
	 * The set-guarantee caption: the base explanation, plus a cap note when a
	 * non-zero candidate cap is set and at least one set is selected -- because the
	 * cap still applies engine-side after the union, so a guaranteed item can still
	 * fall outside the cap (ticket 424, C16/C17).
	 */
	private refreshSetsCaption(): void {
		const base = i18n.t('upgrades_tab.settings.sets_caption');
		const capActive = this.readCandidateCap() !== undefined && this.guaranteedSetKeys.size > 0;
		this.setsCaptionElem.textContent = capActive ? `${base} ${i18n.t('upgrades_tab.settings.sets_cap_note')}` : base;
	}

	/**
	 * The finished run's wall-clock, appended to the done status. Empty
	 * when no run has finished in this page session. Not shown on a stopped run:
	 * a partial elapsed misreads as the cost of a full ranking (ticket 460).
	 * Integer seconds: the figure is compared against a minutes-scale budget, and
	 * sub-second precision would imply a resolution the surface (a foregrounded
	 * browser tab) does not have.
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
		//
		// No `raid` here any more (ticket 417): the content-source filter moved to
		// the run settings and now narrows the candidate pool BEFORE the sim
		// (`effectivePool`), rather than filtering ranked rows after it, so
		// `applyView` sees only the sources the run was asked for.
		return {
			hideOwned: false,
			withSetPotential: this.setPotentialControl.checked,
		};
	}

	/**
	 * The DPS-column sort key for the header sort (ticket 419, C28). With set
	 * potential on and a per-spec floor in hand, the key is the same
	 * `deltaDps + rankableSetPotential` total the cell shows and the engine sorted
	 * on (view.ts's `sortKeyFor`); otherwise it is the bare `deltaDps`. Passed
	 * into `sortRows`/`resultsSortKey`, which are module-level and cannot reach
	 * the toggle or the floor themselves.
	 */
	private deltaSortKey(noiseFloorDps: number | undefined): (row: ViewRow) => number {
		const withSetPotential = this.setPotentialControl.checked && noiseFloorDps !== undefined;
		if (!withSetPotential) return row => row.deltaDps;
		return row => row.deltaDps + rankableSetPotential(row, noiseFloorDps);
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
		const exported = this.resultsSort ? sortRows(view.shortlist, this.resultsSort, this.deltaSortKey(noiseFloorDps)) : view.shortlist;
		this.updateExport(exported);
		return this.resultsBlock(this.rowsTable(view.shortlist, view.rows, noiseFloorDps));
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
	private resultsBlock(table: Node): Node {
		return (
			<div className="upgrades-results-block content-block">
				<div className="content-block-header">
					<h6 className="content-block-title">{i18n.t('upgrades_tab.results.heading')}</h6>
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
				    pass undefined and `setBonusPresentation` shows nothing. */}
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
		const sortedShortlist = this.resultsSort ? sortRows(shortlist, this.resultsSort, this.deltaSortKey(noiseFloorDps)) : shortlist;
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
		const sorted = this.resultsSort ? sortRows(rows, this.resultsSort, this.deltaSortKey(noiseFloorDps)) : rows;
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
	 * exists yet); it is threaded straight to `setBonusPresentation`, which shows
	 * no set-bonus qualifier or tooltip when the floor is absent (tickets 331, 332).
	 *
	 * `cutoff` is the same done ranking's frozen cutoff (or `undefined` mid-run),
	 * threaded so a row admitted above the fold by the percentage arm alone can
	 * say so (ticket 254): the cutoff is an OR (abs OR pct), and a shortlisted
	 * row whose absolute DPS is below the abs threshold reads as if it broke the
	 * absolute rule unless the %-arm is named. The marker's content is the
	 * correctness fix; its visual polish is a follow-up (styling wave).
	 */
	private resultRow(row: RankedItem, display: { rankText: string }, noiseFloorDps: number | undefined, cutoff?: Cutoff): Node {
		// With set potential on, the DPS cell's main figure is the same total the
		// ranking sorted on -- `deltaDps + rankableSetPotential` (ticket 419) --
		// with the bare delta named underneath so the two figures cannot be
		// confused. The engine adds exactly this bonus to `deltaDps` when the
		// toggle is on (view.ts's `sortKeyFor`), so showing the total here makes
		// the number match the row's position. Off, or on a row with no rankable
		// bonus (or the mid-run skeleton, where `noiseFloorDps` is absent), the
		// cell is exactly what it was.
		const setBonus =
			this.setPotentialControl.checked && noiseFloorDps !== undefined ? rankableSetPotential(row, noiseFloorDps) : 0;
		const showSetTotal = setBonus > 0;
		const deltaLabel = formatDelta(showSetTotal ? row.deltaDps + setBonus : row.deltaDps);
		// The DPS cell shows the ranked figure plus at most one short sub-line; the
		// base-delta / per-threshold breakdown moves into a tippy tooltip on the
		// cell (ticket 431). `deltaLabel` (the total the row sorted on, C16) is
		// unchanged.
		const setBonus_ = this.setBonusPresentation(row, noiseFloorDps, showSetTotal, deltaLabel);
		const removedLine = this.removedItemsLine(row);
		const cutoffArmLine = cutoff && cutoffAdmittingArm(row.deltaDps, row.deltaPct, cutoff) === 'pct'
			? (
				<small className="upgrades-cutoff-arm" title={i18n.t('upgrades_tab.cutoff.pct_arm_title', { pct: formatDelta(cutoff.pct), abs: cutoff.absDps })}>
					{i18n.t('upgrades_tab.cutoff.pct_arm')}
				</small>
			)
			: null;
		const dpsCellRef = ref<HTMLTableCellElement>();
		const dpsCell = (
			// `tabIndex=0` only when a tooltip exists, so keyboard focus opens the
			// breakdown (F6: a focusable trigger, not a hover-only fallback); a cell
			// with no tip stays out of the tab order.
			<td ref={dpsCellRef} attributes={setBonus_.tip ? { tabindex: '0' } : {}}>
				{deltaLabel}
				{setBonus_.line}
				{removedLine}
				{cutoffArmLine}
			</td>
		) as HTMLTableCellElement;
		if (setBonus_.tip) tippy(dpsCellRef.value!, { content: setBonus_.tip });
		return (
			<tr className={row.owned ? 'upgrades-row-owned' : ''}>
				<td>{display.rankText}</td>
				<td>{this.itemCell(row)}</td>
				<td>{slotLabel(effectiveSlot(row))}</td>
				{dpsCell}
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
	 * Names the worn item this swap takes off beyond the one it replaces --
	 * today only the off-hand item a two-handed main-hand candidate leaves no
	 * room for (ticket 350).
	 *
	 * A two-hander occupies both hands, so the row is a two-item change. Saying
	 * which item it removes keeps the delta from reading as a one-for-one swap.
	 * The name comes from the same `Database.getSync()` lookup `itemCell` uses,
	 * and falls back to the id when the database has no row for it.
	 */
	private removedItemsLine(row: RankedItem): Node | null {
		const removed = row.removedItems;
		if (!removed?.length) return null;
		return (
			<>
				{removed.map(entry => (
					<small className="upgrades-removed-items">
						{i18n.t('upgrades_tab.results.removes_worn', {
							name: Database.getSync().getItemById(entry.itemId)?.name ?? String(entry.itemId),
							slot: entry.slot,
						})}
					</small>
				))}
			</>
		);
	}

	/**
	 * The DPS cell's set-bonus presentation (ticket 431): at most one short
	 * `<small>` qualifier line for the cell, and a tippy tooltip carrying the full
	 * base-delta / per-threshold breakdown. Splits what were `setBonusLine` (313)
	 * and `setPackageLine` (336) so the cell stays one line and the detail moves
	 * behind hover/focus. The 330-approved strings (`prospective`, `crosses`,
	 * `confounded`, `package_disclosure`) are reused verbatim; the gating that
	 * decides when each renders is unchanged.
	 *
	 * The figure the toggle governs is the sort key, not this text: the qualifier
	 * and tooltip render in both toggle states with the same wording (owner rev
	 * 2). `prospectiveBonusDps` is the raw figure the view adds to `deltaDps`
	 * (`view.ts:163,169-172`), never the report's `SET_POTENTIAL_WEIGHTS`-
	 * discounted one, so it reconciles with the on-screen order.
	 *
	 * The confounded and crossing states each carry their own single line and no
	 * tooltip: confounded is a disclosure the view refuses to rank on (ticket 90),
	 * and crossing's bonus is already inside `deltaDps` (a second figure would be
	 * double-counted). The tooltip exists only when a prospective or package line
	 * would have rendered -- the states that have a base / total to break down.
	 *
	 * `packages[]` disclosure (ticket 336) surfaces a reachable HIGHER-threshold
	 * bonus the nearest-threshold prospective line does not show (a 2pc-
	 * implemented set silent about a real 4pc). It is disclosure, never credit:
	 * it reads `packages[]` only, adds nothing to `deltaDps`, and the sort keys
	 * off `prospectiveBonusDps` in `view.ts`, never `packages[]`. Gated to
	 * packages above the shown threshold whose measured `deltaDps` clears the same
	 * per-spec noise floor, and never in the confounded/crossing states.
	 */
	private setBonusPresentation(
		row: RankedItem,
		noiseFloorDps: number | undefined,
		showSetTotal: boolean,
		deltaLabel: string,
	): { line: Node | null; tip: HTMLElement | null } {
		const ctx = row.setContext;
		if (!ctx) return { line: null, tip: null };

		// Confounded and crossing: one line, no breakdown tooltip.
		const breaks = ctx.prospectiveBonusBreaks;
		if (breaks?.length) {
			const broken = breaks[0];
			const line = (
				<small className="upgrades-set-bonus upgrades-set-bonus-confounded">
					{i18n.t('upgrades_tab.set_bonus.confounded', {
						dps: (ctx.prospectiveBonusDps ?? 0).toFixed(1),
						threshold: ctx.nextThreshold,
						broken: broken.setName,
						brokenThreshold: broken.threshold,
					})}
				</small>
			);
			return { line, tip: null };
		}
		if (ctx.crossesThreshold) {
			const line = <small className="upgrades-set-bonus">{i18n.t('upgrades_tab.set_bonus.crosses', { threshold: ctx.piecesAfterSwap })}</small>;
			return { line, tip: null };
		}

		// Prospective and package breakdown. Only surface figures that clear the
		// per-spec sim-noise floor of the ranking's OWN frozen cutoff (threaded in,
		// never a live picker lookup that may have moved since the run -- tickets
		// 331/332). An absent floor means the mid-run skeleton, which has no honest
		// floor yet, so nothing is disclosed. A near-zero raw figure ("-4.1") reads
		// as a real negative bonus when the honest statement is "nothing
		// measurable"; noise reduction is a separate item (ticket 105).
		const hasProspective =
			noiseFloorDps !== undefined &&
			ctx.prospectiveBonusDps !== undefined &&
			ctx.prospectiveBonusDps > noiseFloorDps &&
			ctx.nextThreshold !== null;
		const shownThreshold = ctx.nextThreshold ?? 0;
		const packages =
			noiseFloorDps !== undefined && ctx.packages?.length
				? ctx.packages.filter(pkg => pkg.threshold > shownThreshold && pkg.deltaDps > noiseFloorDps).sort((a, b) => a.threshold - b.threshold)
				: [];

		if (!hasProspective && packages.length === 0) return { line: null, tip: null };

		// The one cell line always shows the DPS figure inline (ticket 443 — the
		// hover-cue mode was dropped because "hover for 4pc bonus" was as long as
		// just showing the number, so it earned nothing). The figure is the one the
		// tooltip carries: the prospective figure when present, else the lowest
		// disclosed package's. `total_inline` when set potential folded the bonus
		// into the shown DPS figure, else `inline` at the lowest reachable
		// threshold. `line-height: 1.2` and `white-space: nowrap` keep the one-line
		// string inside the layout gate's height budget; a longer string widens the
		// DPS column instead of wrapping, so the SME-chosen strings are picked to
		// fit at 375 (the gate's no-clip / no-horizontal-scroll checks decide).
		const lowestReachable = hasProspective ? (ctx.nextThreshold as number) : packages[0].threshold;
		const inlineDps = (hasProspective ? (ctx.prospectiveBonusDps as number) : packages[0].deltaDps).toFixed(1);
		const lineText = showSetTotal
			? i18n.t('upgrades_tab.set_bonus.total_inline', { threshold: ctx.nextThreshold ?? 0, dps: inlineDps })
			: i18n.t('upgrades_tab.set_bonus.inline', { threshold: lowestReachable, dps: inlineDps });
		const line = <small className="upgrades-set-bonus">{lineText}</small>;

		// The tooltip: base, then the 330 prospective and package lines verbatim
		// (same gating as the old cell lines), then the total when it is shown.
		const tip = (
			<div className="upgrades-set-bonus-tip">
				<div>{i18n.t('upgrades_tab.set_bonus.tip_base', { base: formatDelta(row.deltaDps) })}</div>
				{hasProspective ? (
					<div>
						{i18n.t('upgrades_tab.set_bonus.prospective', {
							worn: ctx.piecesWornBefore,
							dps: (ctx.prospectiveBonusDps as number).toFixed(1),
							threshold: ctx.nextThreshold,
						})}
					</div>
				) : null}
				{packages.map(pkg => (
					<div>
						{i18n.t('upgrades_tab.set_bonus.package_disclosure', {
							worn: ctx.piecesWornBefore,
							dps: pkg.deltaDps.toFixed(1),
							threshold: pkg.threshold,
						})}
					</div>
				))}
				{showSetTotal ? <div>{i18n.t('upgrades_tab.set_bonus.tip_total', { total: deltaLabel })}</div> : null}
			</div>
		) as HTMLElement;

		return { line, tip };
	}

	/**
	 * The yellow tag text for one result row (ticket 430): the name of each
	 * SELECTED set whose items include the row, as the gear tab shows it (the bare
	 * `name`, "BiS 9%", not the phase-prefixed chip `label`). Set membership, not
	 * the universe's `bisTags`, defines "BiS" here -- `bisTags` is a bare enum with
	 * no set identity and its sibling `bisSets` holds phase tokens, never a preset
	 * name (C7/C8), so it cannot say which same-phase preset an item is in. When
	 * two selected sets share a `name` (e.g. P2 and P3 "BiS 9%"), the tags are
	 * disambiguated to "P{phase} {name}" so they do not read identically; a set
	 * with no phase (a saved set) keeps its bare name. Empty when no selected set
	 * contains the row -- the caller then falls back to the generic bisTags badge.
	 */
	private rowTagLabels(row: RankedItem): string[] {
		const selected = this.guaranteedSetsAvailable().filter(set => this.guaranteedSetKeys.has(set.key) && set.itemIds.has(row.itemId));
		return selected.map(set => {
			const shared = selected.some(other => other !== set && other.name === set.name);
			return shared && set.phase !== undefined ? `P${set.phase} ${set.name}` : set.name;
		});
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

		// One tag vocabulary, one class, one colour (ticket 430, the unified rule):
		//  (a)/(b) a row in >=1 selected set gets one yellow `.upgrades-bis-badge`
		//          per selected set containing it, labelled from the set's own name;
		//          the generic bisTags badge is suppressed. Set membership defines
		//          "BiS" -- the universe's bisTags is a phase-scoped derivation from
		//          an older pin of the same preset files (C12), so any disagreement
		//          is data lag, not a second concept.
		//  (c) a row in no selected set falls back to a single generic "BiS"/"Alt"
		//          from bisTags, in the SAME badge class, because that flag still
		//          drives the "BiS only" view filter and the BiS prune (C13). The
		//          `.upgrades-bis-badge` class is deliberately kept (not renamed) so
		//          the layout gate's `.upgrades-bis-badge` probe stays live (C23).
		const tags = this.rowTagLabels(row);
		const bisLabel = row.bisTags.includes('BiS') ? i18n.t('upgrades_tab.results.bis_badge') : row.bisTags.includes('Alt') ? i18n.t('upgrades_tab.results.alt_badge') : undefined;
		const badges =
			tags.length > 0
				? tags.map(tag => <span className="badge rounded-pill upgrades-bis-badge ms-1">{tag}</span>)
				: bisLabel
					? [<span className="badge rounded-pill upgrades-bis-badge ms-1">{bisLabel}</span>]
					: [];

		const cell = (
			<span className="upgrades-item-cell">
				<a className="upgrades-item-link" ref={anchorElem} dataset={{ whtticon: 'false' }}>
					{/* Decorative: the item name follows as text in the same link, so an
					    empty alt lets a screen reader skip the icon rather than read its
					    URL or repeat the name (ticket 444, axe image-alt). */}
					<img className="upgrades-item-icon" ref={iconElem} alt="" />
					<span className="upgrades-item-name" ref={nameElem}>
						{row.name}
					</span>
				</a>
				{badges}
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
		// The content-source filter the run used (ticket 417). Names the excluded
		// sources, or "all" when nothing was unticked.
		lines.push(this.excludedSources.size === 0 ? 'sources: all' : `sources: excluded ${[...this.excludedSources].join(', ')}`);
		// The always-sim sets the run guaranteed in (ticket 424).
		const guaranteedLabels = this.guaranteedSetsAvailable().filter(s => this.guaranteedSetKeys.has(s.key)).map(s => s.label);
		lines.push(guaranteedLabels.length === 0 ? 'sets: none' : `sets: ${guaranteedLabels.join(', ')}`);

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
	// The native anchor is `<a><small>` (item_list.tsx:648-654); the fallback was
	// bare text, so it rendered a step larger and in link-white next to the muted
	// `<small>` anchors (ticket 440). Wrap it in the same `<small>` at the tab's
	// muted colour so a non-link source reads as text of one size, not a link.
	// `sourceLabel`'s text is unchanged, so the desktop-gate golden's `td[4]`
	// readback is unaffected.
	if (rendered === null || isEmptyElement(rendered)) return <small className="upgrades-source-fallback">{sourceLabel(row.source)}</small>;
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
