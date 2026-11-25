import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RunState } from '../../model/run_state';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { StaleNotice, StatusLine } from './StatusLine';

loadEnglishBundles();

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
		expect(summaryOf(run)).toBe('Cancelled: the rows below come from the sims that finished. Your current gear: 2,084.2 DPS.');
	});

	it('says a cancelled run with no finished row has none, in the word the Cancel button uses (ticket 899)', () => {
		const run: RunState = {
			status: 'stopped',
			runId: 1,
			result: { ...RANKING_FIXTURE, items: [{ ...row, simmed: false }], complete: false, durationMs: 900 },
		};
		expect(summaryOf(run)).toBe('Cancelled before any row finished. Your current gear: 2,084.2 DPS.');
	});

	it('counts the rows landed while running, with no baseline yet', () => {
		const { getByTestId, queryByTestId } = render(<StatusLine run={{ status: 'running', runId: 1, startedAt: 0, landedRows: [row], stopping: false }} />);
		expect(getByTestId('upgrades-status-line').textContent).toBe('Rows landed so far: 1.');
		expect(queryByTestId('upgrades-baseline-summary')).toBeNull();
	});

	it('says the run is cancelling while the step in flight finishes (ticket 899)', () => {
		const { getByTestId } = render(<StatusLine run={{ status: 'running', runId: 1, startedAt: 0, landedRows: [row], stopping: true }} />);
		expect(getByTestId('upgrades-status-line').textContent).toBe('Cancelling after the current step finishes.');
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
		const { getByRole } = render(<StatusLine run={{ status: 'error', runId: 1, message: 'Ranking failed.' }} />);
		expect(getByRole('alert').textContent).toBe('Ranking failed.');
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
