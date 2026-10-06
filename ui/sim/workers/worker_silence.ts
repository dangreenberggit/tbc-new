/**
 * Fails a worker that has sent nothing for too long while a request waits on it (ticket 545).
 *
 * A worker that never becomes ready, or a wasm sim that answered its request id and then
 * stopped sending progress, would otherwise leave its callers waiting forever. Every message
 * the worker sends re-arms the timer, so a busy worker is never failed; the limit depends on
 * what the worker is doing, because the warm-up pass of a health-based fight is silent for
 * far longer than the main loop.
 *
 * Each arm sets one timer. A timer that fires more than FREEZE_MS after its due time is read
 * as a frozen page or a sleeping machine, not as a silent worker, and re-arms a full limit
 * (ticket 553). Chrome freezes a page's dedicated workers with the page (Chromium
 * `core/workers/dedicated_worker.cc:662-674`, read for ticket 553), so their silence then says
 * nothing. A hidden tab only delays a timer a little (see FREEZE_MS), so a dead worker in a
 * hidden tab is still failed at about its limit. Two costs. A worker that died before a freeze
 * or sleep is failed up to one limit after it ends. And a healthy worker is failed by a freeze
 * or sleep that ends with less of the limit left than the worker needs for its next message, or
 * that ends at most FREEZE_MS after the due time; in the second case the worker survives only
 * if its queued message runs before the overdue timer, an order Chrome does not document
 * (hypothesis, untested).
 */

/** `presim` while any async sim on the worker has not yet sent its first `PresimRunning: false`. */
export type SilenceRegime = 'start' | 'run' | 'presim';

export type SilenceLimits = {
	/** Created until `ready`: covers the wasm module download. */
	startMs: number;
	/** After `ready`, while no sim is in its warm-up pass. */
	runMs: number;
	/**
	 * From an async sim's post (or from `ready`, when posted earlier) until its first
	 * `PresimRunning: false`. Absent means the run limit applies there too.
	 */
	presimMs?: number;
};

// A hidden tab delays a single timer by only about 1 s, because Chrome throttles only timer
// chains to once a minute (https://developer.chrome.com/blog/timer-throttling-in-chrome-88); a
// freeze or sleep delays it by its whole length. 5 s sits between the two.
const FREEZE_MS = 5_000;

export type SilenceHooks = {
	/** Asked when the timer fires, not tracked by a counter: the pool deletes and re-adds a
	 * progress entry inside one listener call, so a counter would pass through zero. */
	hasWaiters: () => boolean;
	onExpire: (regime: SilenceRegime, limitMs: number) => void;
};

export type SilenceTimers = {
	set: (callback: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

// Wrapped rather than passed bare: called as a method of this object, a bare setTimeout gets a
// plain object as `this`, which a browser may reject with "Illegal invocation" while Node accepts
// it (hypothesis, untested), so tests could not catch it.
const defaultTimers: SilenceTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SilenceMonitor {
	private regime: SilenceRegime = 'start';
	private handle: unknown;
	private armed = false;
	/** When the current timer's limit started: the last message, or the request or late fire that armed it. */
	private basisAt = 0;
	private disposed = false;

	constructor(
		private readonly limits: SilenceLimits,
		private readonly hooks: SilenceHooks,
		private readonly timers: SilenceTimers = defaultTimers,
	) {}

	/**
	 * A request now waits on the worker. When no other request was waiting, the worker's last
	 * message may be almost a full limit old, so the request gets a whole limit of its own;
	 * otherwise the silence the earlier request is already waiting through keeps counting.
	 */
	requestWaiting(othersWaiting = false) {
		if (!othersWaiting || !this.armed) this.arm();
	}

	messageSeen() {
		this.arm();
	}

	/**
	 * A regime change is not a sign of life, so it keeps the time the timer was armed and applies
	 * the new limit from there (ticket 556). A second sim posted to a worker that answers nothing
	 * is therefore failed at the worker's last message plus the presim limit, not at the post plus
	 * the presim limit: up to `presimMs - runMs` later than the earlier request's run deadline,
	 * which ticket 556 accepts by decision. A worker that answers the second request's id re-arms
	 * a full limit on that message, as on every message.
	 *
	 * When a change that is not a message shortens the limit below the time already passed
	 * (presim to run when a request ends), the timer fires at 0 ms: the late-fire check fails the
	 * worker at once if it is at most FREEZE_MS past the due time, else reads it as a freeze and
	 * arms a fresh full limit. That needs a request to end with no message and no expiry, which
	 * has not been seen (hypothesis, untested).
	 */
	setRegime(regime: SilenceRegime) {
		if (regime === this.regime) return;
		this.regime = regime;
		this.arm(this.armed ? this.basisAt : Date.now());
	}

	dispose() {
		this.disposed = true;
		this.stop();
	}

	private limitMs(): number {
		switch (this.regime) {
			case 'start':
				return this.limits.startMs;
			case 'presim':
				return this.limits.presimMs ?? this.limits.runMs;
			default:
				return this.limits.runMs;
		}
	}

	// Wall clock, not performance.now(): it keeps counting through system sleep (hypothesis,
	// untested in Chrome), and vitest's fake performance.now() ignores setSystemTime (measured on
	// vitest 3.2.7: `performance.now()` unchanged after `vi.setSystemTime`; its bundled
	// fake-timers 14.0.0 subtracts the system-time adjustment in `hrtime`).
	private arm(basisAt = Date.now()) {
		if (this.disposed) return;
		this.stop();
		const regime = this.regime;
		const limitMs = this.limitMs();
		this.basisAt = basisAt;
		this.armed = true;
		this.handle = this.timers.set(
			() => {
				this.armed = false;
				this.handle = undefined;
				if (this.disposed || !this.hooks.hasWaiters()) return;
				if (Date.now() - basisAt - limitMs > FREEZE_MS) {
					this.arm();
					return;
				}
				this.hooks.onExpire(regime, limitMs);
			},
			Math.max(0, basisAt + limitMs - Date.now()),
		);
	}

	private stop() {
		if (this.armed) this.timers.clear(this.handle);
		this.armed = false;
		this.handle = undefined;
	}
}
