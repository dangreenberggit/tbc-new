import { Tab } from 'bootstrap';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { IndividualSimUI } from '../../individual_sim_ui';
import { SimTab } from '../sim_tab';
import { PlayerGearSource } from './upgrades/adapters/player_gear_source';
import { currentPageSkeleton } from './upgrades/adapters/skeleton';
import { WasmSimRunner } from './upgrades/adapters/wasm_sim_runner';
import { epWeightsFor, poolFor } from './upgrades/data/data';
import { applyView, type ViewRow } from './upgrades/engine/view';
import { rankUpgrades, type Progress, type Ranking, type RankInput } from './upgrades/engine/rank';
import { MemoryStore } from './upgrades/engine/seams/store';
import type { SpecId } from './upgrades/engine/types';
import { Spec } from '../../proto/common.js';

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

		this.contentContainer.appendChild(
			<>
				<div className="upgrades-tab-left tab-panel-left">
					<div className="upgrades-tab-tabs">
						<ul className="nav nav-tabs" attributes={{ role: 'tablist' }}>
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
						<div className="tab-content">
							<div id="upgradesShoppingListTab" className="tab-pane fade active show" ref={shoppingListRef} />
						</div>
					</div>
				</div>
			</>,
		);

		this.shoppingListElem = shoppingListRef.value!;

		new Tab(shoppingListBtnRef.value!);

		this.buildTabContent();
		this.wireStalenessListeners();
	}

	protected buildTabContent() {
		const runButtonRef = ref<HTMLButtonElement>();
		const statusRef = ref<HTMLDivElement>();
		const resultsRef = ref<HTMLDivElement>();

		this.shoppingListElem.appendChild(
			<div className="upgrades-shopping-list p-gap">
				<div className="upgrades-run-row d-flex align-items-center gap-2">
					<button ref={runButtonRef} className="btn btn-primary upgrades-run-button" type="button">
						{i18n.t('upgrades_tab.run')}
					</button>
					<div ref={statusRef} className="upgrades-status text-muted" />
				</div>
				<div ref={resultsRef} className="upgrades-results mt-gap" />
			</div>,
		);

		this.runButton = runButtonRef.value!;
		this.statusElem = statusRef.value!;
		this.resultsElem = resultsRef.value!;

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
		this.resultsElem.replaceChildren(this.resultsContent());
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
					<span className="text-warning">
						{label} — {i18n.t('upgrades_tab.status.stale')}
					</span>
				) : (
					<span>{label}</span>
				);
			}
		}
	}

	private resultsContent(): Node {
		if (this.state.kind !== 'done') return <></>;
		const view = applyView(this.state.ranking);
		if (view.shortlist.length === 0) {
			return <div className="text-muted">{i18n.t('upgrades_tab.results.empty')}</div>;
		}
		return (
			<table className="upgrades-results-table table table-sm">
				<thead>
					<tr>
						<th>{i18n.t('upgrades_tab.results.rank')}</th>
						<th>{i18n.t('upgrades_tab.results.item')}</th>
						<th>{i18n.t('upgrades_tab.results.slot')}</th>
						<th>{i18n.t('upgrades_tab.results.delta_dps')}</th>
					</tr>
				</thead>
				<tbody>{view.shortlist.map((row) => this.resultRow(row))}</tbody>
			</table>
		);
	}

	private resultRow(row: ViewRow): Node {
		return (
			<tr className={row.owned ? 'upgrades-row-owned' : ''}>
				<td>{row.rank ?? '—'}</td>
				<td>{row.name}</td>
				<td>{row.slotChoice ?? row.slot}</td>
				<td>{`+${row.deltaDps.toFixed(1)}`}</td>
			</tr>
		);
	}
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
