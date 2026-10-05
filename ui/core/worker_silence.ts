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
 * (ticket 553). Chrome freezes a page's dedicated workers with the page, so their silence
 * then says nothing. A hidden tab delays a single timer by only about 1 s, because only timer
 * chains are throttled to once a minute
 * (https://developer.chrome.com/blog/timer-throttling-in-chrome-88), so a dead worker in a
 * hidden tab is still failed at about its limit. Two costs: a worker that died before a
 * freeze or sleep is failed up to one limit after it ends; and a freeze or sleep that ends
 * 0-5 s after the due time still fails a healthy worker (at the Upgrades tab's limits, a
 * freeze of about 29-35 s in the main loop or 108-125 s in a warm-up), unless the worker's
 * queued message runs before the overdue timer, an order Chrome does not document
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

// A hidden tab delays a single timer by about 1 s; a freeze or sleep delays it by its whole
// length. 5 s sits between the two.
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

	setRegime(regime: SilenceRegime) {
		if (regime === this.regime) return;
		this.regime = regime;
		this.arm();
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

	private arm() {
		if (this.disposed) return;
		this.stop();
		const regime = this.regime;
		const limitMs = this.limitMs();
		// Wall clock, not performance.now(): it keeps counting through system sleep (hypothesis,
		// untested in Chrome), and vitest's fake performance.now() ignores setSystemTime.
		const armedAt = Date.now();
		this.armed = true;
		this.handle = this.timers.set(() => {
			this.armed = false;
			this.handle = undefined;
			if (this.disposed || !this.hooks.hasWaiters()) return;
			if (Date.now() - armedAt - limitMs > FREEZE_MS) {
				this.arm();
				return;
			}
			this.hooks.onExpire(regime, limitMs);
		}, limitMs);
	}

	private stop() {
		if (this.armed) this.timers.clear(this.handle);
		this.armed = false;
		this.handle = undefined;
	}
}
