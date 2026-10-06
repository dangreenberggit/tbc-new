import i18n from '@i18n/config';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import type { RunState } from '../../model/run_reducer';
import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { StatusLine } from './StatusLine';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

const row = fixtureRow(0);
const summaryOf = (run: RunState) => render(<StatusLine run={run} />).queryByTestId('upgrades-baseline-summary')?.textContent;

describe('StatusLine', () => {
	it('gives a finished run’s baseline and how long it took', () => {
		const run: RunState = { status: 'done', runId: 1, result: { ...RANKING_FIXTURE, durationMs: 2549 } };
		expect(summaryOf(run)).toBe('Your current gear: 2,084.2 DPS. Took 2.5s.');
	});

	it('gives no time for a stopped run, whose duration is not the cost of a ranking', () => {
		const run: RunState = { status: 'stopped', runId: 1, result: { ...RANKING_FIXTURE, items: [row], complete: false, durationMs: 900 } };
		expect(summaryOf(run)).toBe('Stopped early. Your current gear: 2,084.2 DPS. The rows below finished before Stop.');
	});

	it('counts the rows landed while running, with no baseline yet', () => {
		const { getByTestId, queryByTestId } = render(<StatusLine run={{ status: 'running', runId: 1, startedAt: 0, landedRows: [row] }} />);
		expect(getByTestId('upgrades-status-line').textContent).toBe('Rows landed so far: 1.');
		expect(queryByTestId('upgrades-baseline-summary')).toBeNull();
	});

	it('says nothing before a run', () => {
		expect(render(<StatusLine run={{ status: 'idle' }} />).container.textContent).toBe('');
	});
});
