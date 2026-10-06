import i18n from '@i18n/config';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import type { UpgradesSettings } from '../../hooks/useUpgradesSettings';
import { initialSettings } from '../../model/settings_reducer';

// The phase picker reads the page's sim; `PhaseSelector.test.tsx` covers it.
vi.mock('../PhaseSelector', () => ({ PhaseSelector: () => null }));

const { RunSettingsPanel } = await import('./RunSettingsPanel');

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

const settingsWith = (dispatch: UpgradesSettings['dispatch']): UpgradesSettings => ({
	state: initialSettings({ iterations: 500 }),
	dispatch,
	sources: { raids: [{ key: 'Black Temple', label: 'Black Temple', count: 3 }], other: [] },
	selectedOptions: [],
	selectedKeys: [],
	chips: { main: [], other: [] },
	runSettings: { iterations: 500 },
	eligibleCount: 3,
	iterationsField: { current: 500 },
	capField: { current: 0 },
	onIterationsChange: () => {},
	onCapChange: () => {},
});

const mount = (devVisible = false) => {
	const onStart = vi.fn();
	const dispatch = vi.fn();
	render(<RunSettingsPanel settings={settingsWith(dispatch)} ready running={false} devVisible={devVisible} onStart={onStart} />);
	return { onStart, dispatch };
};

const classes = (element: HTMLElement) => element.className.split(' ');

describe('RunSettingsPanel', () => {
	it('keeps the settings behind a summary button below xl, with the count and Run outside it', () => {
		mount();
		const summary = screen.getByTestId('upgrades-run-settings-summary');
		const body = screen.getByTestId('upgrades-run-settings-body');
		expect(summary.getAttribute('aria-expanded')).toBe('false');
		expect(summary.getAttribute('aria-controls')).toBe(body.id);
		expect(classes(summary)).toContain('xl:hidden');
		expect(classes(body)).toEqual(expect.arrayContaining(['hidden', 'xl:grid']));
		expect(body.contains(screen.getByTestId('upgrades-eligible-count'))).toBe(false);
		expect(body.contains(screen.getByTestId('upgrades-run-button'))).toBe(false);

		fireEvent.click(summary);
		expect(summary.getAttribute('aria-expanded')).toBe('true');
		expect(classes(body)).toContain('grid');
		expect(classes(body)).not.toContain('hidden');
	});

	it('runs from the Run button', () => {
		const { onStart } = mount();
		fireEvent.click(screen.getByTestId('upgrades-run-button'));
		expect(onStart).toHaveBeenCalledOnce();
	});

	it('sends a source tick to the settings reducer', () => {
		const { dispatch } = mount();
		fireEvent.click(screen.getByTestId('upgrades-sources-button'));
		fireEvent.click(screen.getByRole('checkbox'));
		expect(dispatch).toHaveBeenCalledWith({ type: 'toggleSource', key: 'Black Temple' });
	});

	it('hides the candidate cap unless the dev flag is on', () => {
		mount();
		expect(screen.getByTestId('upgrades-candidates-picker').parentElement?.hidden).toBe(true);
	});

	it('shows the candidate cap under the dev flag', () => {
		mount(true);
		expect(screen.getByTestId('upgrades-candidates-picker').parentElement?.hidden).toBe(false);
	});
});
