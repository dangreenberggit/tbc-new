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

const mount = () => {
	const host = fakeTabHost();
	clearProgress(host.player);
	render(
		<SimHostProvider host={host}>
			<RunProgressDialog onStop={() => {}} stopping={false} />
		</SimHostProvider>,
	);
	return host.player;
};

const counter = () => screen.queryByTestId('progress-tracker-modal-progress-text')?.textContent ?? null;
const message = () => screen.getByTestId('progress-tracker-modal-message').textContent;

describe('RunProgressDialog', () => {
	it('shows the count while candidates are simmed', () => {
		const player = mount();
		act(() => emitProgress(player, view({ done: 300, total: 699 })));
		expect(counter()).toBe('300/699');
		expect(message()).toBe('Simming candidates');
	});

	it('shows no count while set bonuses are measured, since that stage sends none', () => {
		const player = mount();
		act(() => emitProgress(player, view({ done: 662, total: 699 })));
		act(() => emitProgress(player, view({ activity: 'set-bonuses', done: 663, total: 699 })));
		expect(counter()).toBeNull();
		expect(message()).toBe('Measuring set bonuses');
	});

	it('shows the count again once the top rows are re-simmed', () => {
		const player = mount();
		act(() => emitProgress(player, view({ activity: 'set-bonuses', done: 663, total: 699 })));
		act(() => emitProgress(player, view({ activity: 'replication', done: 667, total: 699 })));
		expect(counter()).toBe('667/699');
		expect(message()).toBe('Re-simming the top rows');
	});
});
