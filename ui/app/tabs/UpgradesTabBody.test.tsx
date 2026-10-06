import type { RunDeps } from '@features/upgrades/model/run';
import type { RunResult } from '@features/upgrades/model/run_reducer';
import { fixtureRow, RANKING_FIXTURE } from '@features/upgrades/testing/ranking_fixture';
import i18n from '@i18n/config';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../assets/locales/en/character.json';
import englishTranslations from '../../../assets/locales/en/translation.json';

/** The live run, replaced by one the test settles by hand; the engine and its data are never loaded. */
const runs: Array<{ deps: RunDeps; settle: (result: RunResult) => void }> = [];
vi.mock('@features/upgrades/model/run', () => ({
	rankForPlayer: (_host: unknown, _settings: unknown, deps: RunDeps) => new Promise<RunResult>(settle => runs.push({ deps, settle })),
	createRunContext: () => ({ terminate: () => {} }),
	specIdFor: () => 'ret',
}));
vi.mock('@sim/hooks/useSimReady', () => ({ useSimReady: () => true }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { UpgradesTabBody } = await import('./UpgradesTabBody');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const rowA = fixtureRow(0);
const rowB = fixtureRow(1);

const mount = () => {
	runs.length = 0;
	render(
		<SimHostProvider host={fakeHost()}>
			<UpgradesTabBody />
		</SimHostProvider>,
	);
	fireEvent.click(screen.getByTestId('upgrades-run-button'));
	const run = runs[0];
	if (!run) throw new Error('Run did not start a run');
	return run;
};

const tableRows = () => within(screen.getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row');

describe('UpgradesTabBody', () => {
	it('shows rows as they land, and keeps them when Stop ends the run', async () => {
		const run = mount();
		expect(screen.getByTestId('upgrades-run-progress')).not.toBeNull();

		act(() => {
			run.deps.onLanded(rowA);
			run.deps.onLanded(rowB);
		});
		expect(tableRows()).toHaveLength(2);

		fireEvent.click(screen.getByTestId('progress-tracker-modal-cancel-btn'));
		expect(run.deps.signal.aborted).toBe(true);
		// The dialog covers the status line for the whole wait, so the dialog itself says so.
		expect(screen.getByTestId('progress-tracker-modal-message').textContent).toBe('Stopping — finishing the current step.');
		await act(async () => run.settle({ ...RANKING_FIXTURE, items: [rowA, rowB], complete: false, durationMs: 800 }));

		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toMatch(/^Stopped early\./);
		expect(tableRows()).toHaveLength(2);
		expect(screen.queryByTestId('upgrades-run-progress')).toBeNull();
	});

	it('shows the whole ranking and how long it took when the run finishes', async () => {
		const run = mount();
		await act(async () => run.settle({ ...RANKING_FIXTURE, durationMs: 4200 }));

		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toMatch(/Took 4\.2s\.$/);
		expect(tableRows()).toHaveLength(RANKING_FIXTURE.items.length);
		expect((screen.getByTestId('upgrades-run-button') as HTMLButtonElement).disabled).toBe(false);
	});
});
