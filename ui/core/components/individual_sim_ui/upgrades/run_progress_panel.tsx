/**
 * The Upgrades tab's progress component while a run is in flight (ticket 542).
 *
 * It reuses the Bulk tab's progress dialog markup and classes
 * (`progress_tracker_modal.tsx`), so the two read as one idiom, but it is not a
 * modal: it sits at the top of the tab's results area, which fills with rows
 * during a run, and covers nothing. The `.modal-content` / `.modal-header` /
 * `.modal-body` classes give it the dialog's box; `_upgrades_tab.scss` supplies
 * the `--bs-modal-*` values those classes only get inside a real `.modal`.
 *
 * Nothing in here is a live region: the tab's announce element speaks run
 * transitions, and a ticking clock or count would bury them.
 */

import { ref } from 'tsx-vanilla';

import i18n from '../../../../i18n/config.js';
import { formatDurationSeconds } from '../../../utils.js';
import { formatElapsed, type RunProgressView } from './run_progress.js';

const TITLE_ID = 'upgrades-run-progress-title';

export class RunProgressPanel {
	/** The whole component, hidden until `start`. */
	readonly root: HTMLElement;
	private readonly phaseElem: HTMLElement;
	private readonly barElem: HTMLElement;
	private readonly countElem: HTMLElement;
	private readonly elapsedElem: HTMLElement;
	private readonly rowsElem: HTMLElement;
	private readonly remainingElem: HTMLElement;
	private readonly stopButton: HTMLButtonElement;
	private timer: number | undefined;

	constructor({ onStop }: { onStop: () => void }) {
		const phaseRef = ref<HTMLDivElement>();
		const barRef = ref<HTMLDivElement>();
		const countRef = ref<HTMLDivElement>();
		const elapsedRef = ref<HTMLSpanElement>();
		const rowsRef = ref<HTMLDivElement>();
		const remainingRef = ref<HTMLDivElement>();
		const stopRef = ref<HTMLButtonElement>();

		this.root = (
			<section className="upgrades-run-progress modal-content d-none">
				<div className="modal-header">
					<h5 className="modal-title" id={TITLE_ID}>
						{i18n.t('upgrades_tab.run_progress.title')}
					</h5>
				</div>
				<div className="modal-body">
					<div className="progress-tracker-modal-content">
						<div className="progress-tracker-modal-progress-container">
							<div ref={phaseRef} className="progress-tracker-modal-progress-title mb-2 upgrades-run-progress-phase" />
							<div className="progress">
								<div ref={barRef} className="progress-bar" attributes={{ role: 'progressbar' }} />
							</div>
							<div ref={countRef} className="progress-tracker-modal-progress-text upgrades-run-progress-count" />
						</div>
						<div className="progress-tracker-modal-time-display">
							<strong>{i18n.t('common.elapsed_time')}:</strong>{' '}
							<span ref={elapsedRef} className="time-elapsed upgrades-run-progress-elapsed" />
						</div>
						<div className="progress-tracker-modal-message">
							<div ref={rowsRef} className="upgrades-run-progress-rows" />
							<div ref={remainingRef} className="upgrades-run-progress-remaining d-none" />
						</div>
						<button ref={stopRef} type="button" className="btn btn-outline-cancel progress-tracker-modal-cancel-btn upgrades-run-progress-stop">
							<i className="fa fa-ban me-1"></i>
							{i18n.t('upgrades_tab.stop')}
						</button>
					</div>
				</div>
			</section>
		) as HTMLElement;
		// Set here: the JSX `attributes` type for a section has no `aria-labelledby`.
		this.root.setAttribute('aria-labelledby', TITLE_ID);
		this.phaseElem = phaseRef.value!;
		this.barElem = barRef.value!;
		this.countElem = countRef.value!;
		this.elapsedElem = elapsedRef.value!;
		this.rowsElem = rowsRef.value!;
		this.remainingElem = remainingRef.value!;
		this.stopButton = stopRef.value!;
		this.stopButton.addEventListener('click', () => {
			this.stopButton.disabled = true;
			onStop();
		});
	}

	get visible(): boolean {
		return !this.root.classList.contains('d-none');
	}

	/** Shows the component and ticks the elapsed time from `startedAt` (`performance.now()`), the clock "Took" uses. */
	start(startedAt: number): void {
		this.root.classList.remove('d-none');
		this.stopButton.disabled = false;
		const tick = () => setText(this.elapsedElem, formatElapsed(performance.now() - startedAt));
		tick();
		window.clearInterval(this.timer);
		this.timer = window.setInterval(tick, 100);
	}

	stop(): void {
		window.clearInterval(this.timer);
		this.timer = undefined;
		this.root.classList.add('d-none');
	}

	update(view: RunProgressView, rowsLanded: number): void {
		setData(this.root, 'phase', view.phase);
		setData(this.root, 'done', view.done);
		setData(this.root, 'total', view.total);
		setData(this.root, 'boundary', view.boundary ?? undefined);
		setData(this.root, 'remainingMs', view.remainingMs === undefined ? undefined : Math.round(view.remainingMs));
		setData(this.root, 'concurrency', view.concurrency);
		setData(this.root, 'qualifyingRows', view.qualifyingRows);

		setText(this.phaseElem, phaseLabel(view));

		const hasRatio = view.done !== undefined && view.total !== undefined && view.total > 0;
		// Without a sim count the bar moves but claims no width: a 0% or 100%
		// bar would read as "not started" or "finished" when neither is true.
		// With one, upstream's green shimmer already moves, so no stripes.
		const pct = hasRatio ? Math.min(100, Math.round((view.done! / view.total!) * 100)) : undefined;
		setClass(this.barElem, pct === undefined ? 'progress-bar progress-bar-striped progress-bar-animated' : 'progress-bar');
		const width = `${pct ?? 100}%`;
		if (this.barElem.style.width !== width) this.barElem.style.width = width;
		// A progressbar needs a name of its own; the phase text beside it
		// changes, so a stable label is the name (ticket 446).
		setAttr(this.barElem, 'aria-label', i18n.t('upgrades_tab.progress.aria_label'));
		setAttr(this.barElem, 'aria-valuemin', '0');
		setAttr(this.barElem, 'aria-valuemax', '100');
		setAttr(this.barElem, 'aria-valuenow', pct?.toString());

		setText(this.countElem, hasRatio ? `${view.done}/${view.total}` : '');
		setText(this.rowsElem, i18n.t('upgrades_tab.run_progress.rows_landed', { count: rowsLanded }));
		if (view.remainingMs === undefined) {
			this.remainingElem.classList.add('d-none');
		} else {
			setText(this.remainingElem, i18n.t('bulk_tab.progress.time_remaining', { time: formatDurationSeconds(view.remainingMs / 1000) }));
			this.remainingElem.classList.remove('d-none');
		}
	}
}

function phaseLabel(view: RunProgressView): string {
	switch (view.phase) {
		case 'preparing':
			switch (view.stage) {
				case 'reading-gear':
					return i18n.t('upgrades_tab.progress.reading_gear');
				case 'composing':
					return i18n.t('upgrades_tab.progress.composing');
				case 'building-pool':
					return i18n.t('upgrades_tab.progress.building_pool');
				default:
					return i18n.t('upgrades_tab.progress.resolving');
			}
		case 'candidates':
			return i18n.t('upgrades_tab.run_progress.phase_candidates');
		case 'set-bonuses':
			return i18n.t('upgrades_tab.run_progress.phase_set_bonuses');
		case 'replication':
			return i18n.t('upgrades_tab.run_progress.phase_replication');
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking');
	}
}

// The setters below write only on a change, so an observer of the component
// sees one mutation per real change rather than one per progress event.

function setText(elem: HTMLElement, text: string): void {
	if (elem.textContent !== text) elem.textContent = text;
}

function setClass(elem: HTMLElement, className: string): void {
	if (elem.className !== className) elem.className = className;
}

function setAttr(elem: HTMLElement, name: string, value: string | undefined): void {
	if (value === undefined) {
		if (elem.hasAttribute(name)) elem.removeAttribute(name);
	} else if (elem.getAttribute(name) !== value) {
		elem.setAttribute(name, value);
	}
}

function setData(elem: HTMLElement, key: string, value: string | number | undefined): void {
	const text = value === undefined ? undefined : String(value);
	if (text === undefined) {
		if (key in elem.dataset) delete elem.dataset[key];
	} else if (elem.dataset[key] !== text) {
		elem.dataset[key] = text;
	}
}
