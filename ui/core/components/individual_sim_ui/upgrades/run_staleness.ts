/**
 * When a shown Upgrades result goes stale after a run input changes (gear,
 * talents, sim settings, or the tab's own run settings).
 *
 * A run reads its inputs once, when it starts (`rank.ts` calls `readGear`
 * once), so a change made while the run is in flight leaves the finished
 * result measured on the old inputs. The change cannot be stored on the
 * `running` state: the progress callback replaces that state on every tick.
 * So the tracker keeps it until the run ends (ticket 537).
 */
export class RunStaleness {
	private changedDuringRun = false;

	runStarted(): void {
		this.changedDuringRun = false;
	}

	/**
	 * Returns the state to show after an input change: a shown result
	 * (`done`, or `stopped` with its partial rows) marked stale, or `state`
	 * itself when there is nothing shown to mark.
	 */
	inputChanged<S extends { readonly kind: string }>(state: S): S {
		if (state.kind === 'done' || state.kind === 'stopped') return { ...state, stale: true };
		if (state.kind === 'running') this.changedDuringRun = true;
		return state;
	}

	/** The `stale` flag for the state a run ends in, `done` or `stopped`. */
	staleAtFinish(): boolean {
		return this.changedDuringRun;
	}
}
