import { fakeTabHost } from '@features/upgrades/testing/fake_tab_host';
import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { clearProgress, emitProgress } from '../../model/progress_channel';
import type { RunProgressView } from '../../model/run_progress';
import { RunProgressDialog } from './RunProgressDialog';

loadEnglishBundles();

const view = (overrides: Partial<RunProgressView>): RunProgressView => ({
	activity: 'candidates',
	stage: 'simming',
	doneAtLastCandidate: 663,
	concurrency: 4,
	replicableRowCount: 0,
	...overrides,
});

const mount = (stopping = false) => {
	const host = fakeTabHost();
	clearProgress(host.player);
	const ui = (isStopping: boolean) => (
		<SimHostProvider host={host}>
			<RunProgressDialog onStop={() => {}} stopping={isStopping} />
		</SimHostProvider>
	);
	const result = render(ui(stopping));
	return { player: host.player, rerender: (isStopping: boolean) => result.rerender(ui(isStopping)) };
};

const counter = () => screen.queryByTestId('progress-tracker-modal-progress-text')?.textContent ?? null;
const timeLeft = () => screen.queryByTestId('upgrades-run-time-left')?.textContent ?? null;
const message = () => screen.getByTestId('progress-tracker-modal-message').textContent;

describe('RunProgressDialog', () => {
	it('shows the count and the time left while candidates are simmed', () => {
		const { player } = mount();
		act(() => emitProgress(player, view({ done: 300, total: 699, remainingMs: 245_000 })));
		expect(counter()).toBe('300/699');
		expect(message()).toBe('Simming candidates4m 05s remaining');
		expect(timeLeft()).toBe('4m 05s remaining');
	});

	it('shows no count and no time left while set bonuses are measured', () => {
		const { player } = mount();
		act(() => emitProgress(player, view({ done: 662, total: 699, remainingMs: 245_000 })));
		act(() => emitProgress(player, view({ activity: 'set-bonuses', done: 663, total: 699 })));
		expect(counter()).toBeNull();
		expect(timeLeft()).toBeNull();
		expect(message()).toBe('Measuring set bonuses');
	});

	it('shows the count and the time left again once the top rows are re-simmed', () => {
		const { player } = mount();
		act(() => emitProgress(player, view({ activity: 'set-bonuses', done: 663, total: 699 })));
		act(() => emitProgress(player, view({ activity: 'replication', done: 667, total: 699, remainingMs: 120_000 })));
		expect(counter()).toBe('667/699');
		expect(timeLeft()).toBe('2m 00s remaining');
	});

	it('says only that it is stopping after Stop', () => {
		const { player, rerender } = mount();
		act(() => emitProgress(player, view({ done: 300, total: 699, remainingMs: 245_000 })));
		rerender(true);
		expect(message()).toBe('Stopping — finishing the current step.');
		expect(timeLeft()).toBeNull();
	});
});
