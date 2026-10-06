import { useSimHost } from '@sim/context/SimHostContext';
import { useEffect, useEffectEvent } from 'react';

import type { Ranking } from '../model/engine/rank';
import { FIXTURES_ENABLED } from '../utils/dev_flags';
import { loadFixture, recordingOf } from '../utils/fixture';

export type FixtureAutoloadOptions = {
	/** Shows a loaded fixture's ranking as a finished run. */
	onLoaded: (ranking: Ranking) => void;
	/** The finished ranking on screen, for the recorder. */
	currentRanking: () => Ranking | undefined;
};

/**
 * The page hooks the dev server's fixture plugin, the fixture recorder and the
 * fixture file input call (`tools/vite/tab_fixtures.mts`, the repo's
 * `scripts/tab-fixtures/record.mjs`, `FixtureFileInput`). The only code in the
 * tab that installs anything on `window`; a production build installs nothing.
 */
export function useFixtureAutoload({ onLoaded, currentRanking }: FixtureAutoloadOptions): void {
	const host = useSimHost();
	// Effect events, so a new callback identity on each render does not re-install the hooks.
	const show = useEffectEvent(onLoaded);
	const readRanking = useEffectEvent(currentRanking);

	useEffect(() => {
		if (!FIXTURES_ENABLED) return;
		window.__upgradesFixture = payload => loadFixture(host, payload, ranking => show(ranking));
		window.__upgradesRanking = () => recordingOf(host, readRanking());
		return () => {
			delete window.__upgradesFixture;
			delete window.__upgradesRanking;
		};
	}, [host]);
}
