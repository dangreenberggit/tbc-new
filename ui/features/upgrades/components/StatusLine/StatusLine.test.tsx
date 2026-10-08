import i18n from '@i18n/config';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../../assets/locales/en/upgrades.json';
import type { RunState } from '../../model/run_reducer';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { StaleNotice, StatusLine } from './StatusLine';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
beforeAll(() => i18n.addResourceBundle('en', 'upgrades', upgradesTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterAll(() => i18n.removeResourceBundle('en', 'upgrades'));

const row = fixtureRow(0);
const summaryOf = (run: RunState) => render(<StatusLine run={run} />).queryByTestId('upgrades-baseline-summary')?.textContent;

describe('StatusLine', () => {
	it('gives a finished run’s baseline and how long it took', () => {
		const run: RunState = { status: 'done', runId: 1, result: { ...RANKING_FIXTURE, durationMs: 2549 } };
		expect(summaryOf(run)).toBe('Your current gear: 2,084.2 DPS. Took 2.5s.');
	});

	it('gives a loaded fixture’s baseline with no time, since nothing ran', () => {
		expect(summaryOf({ status: 'done', runId: 1, result: RANKING_FIXTURE })).toBe('Your current gear: 2,084.2 DPS.');
	});

	it('gives no time for a stopped run, whose duration is not the cost of a ranking', () => {
		const run: RunState = { status: 'stopped', runId: 1, result: { ...RANKING_FIXTURE, items: [row], complete: false, durationMs: 900 } };
		expect(summaryOf(run)).toBe('Stopped early. Your current gear: 2,084.2 DPS. The rows below finished before Stop.');
	});

	it('counts the rows landed while running, with no baseline yet', () => {
		const { getByTestId, queryByTestId } = render(<StatusLine run={{ status: 'running', runId: 1, startedAt: 0, landedRows: [row], stopping: false }} />);
		expect(getByTestId('upgrades-status-line').textContent).toBe('Rows landed so far: 1.');
		expect(queryByTestId('upgrades-baseline-summary')).toBeNull();
	});

	it('says the run is stopping while the step in flight finishes', () => {
		const { getByTestId } = render(<StatusLine run={{ status: 'running', runId: 1, startedAt: 0, landedRows: [row], stopping: true }} />);
		expect(getByTestId('upgrades-status-line').textContent).toBe('Stopping — finishing the current step.');
	});

	it('says what the tab does before a run, in the polite region', () => {
		const { getByTestId } = render(<StatusLine run={{ status: 'idle' }} />);
		expect(getByTestId('upgrades-status-polite').textContent).toBe('Ranks upgrades against your current gear and settings on this page.');
		expect(getByTestId('upgrades-status-alert').textContent).toBe('');
	});

	it('keeps both live regions in the page in every state, the polite one for progress and the alert for a failure only', () => {
		const states: RunState[] = [
			{ status: 'idle' },
			{ status: 'running', runId: 1, startedAt: 0, landedRows: [row], stopping: false },
			{ status: 'done', runId: 1, result: RANKING_FIXTURE },
		];
		for (const run of states) {
			const { getByRole, unmount } = render(<StatusLine run={run} />);
			expect(getByRole('status').getAttribute('aria-live')).toBe('polite');
			expect(getByRole('status').getAttribute('aria-atomic')).toBe('true');
			expect(getByRole('status').textContent).not.toBe('');
			expect(getByRole('alert').textContent).toBe('');
			unmount();
		}
	});

	it('puts a failure in the alert region and leaves the polite region empty', () => {
		const { getByRole } = render(<StatusLine run={{ status: 'error', runId: 1, message: 'Ranking failed: boom' }} />);
		expect(getByRole('alert').textContent).toBe('Ranking failed: boom');
		expect(getByRole('status').textContent).toBe('');
	});
});

describe('StaleNotice', () => {
	it('says the result is out of date and how to refresh it', () => {
		expect(render(<StaleNotice />).getByTestId('upgrades-stale').textContent).toBe(
			'settings changed since this ranking — results may be out of date Run again to rank with the current settings.',
		);
	});
});
