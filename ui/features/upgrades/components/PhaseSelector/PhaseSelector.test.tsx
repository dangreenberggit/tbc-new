import i18n from '@i18n/config';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { PhaseSelector } from './PhaseSelector';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

/** The page's phase, in a real sim store. */
const mount = () => {
	const store = createSimStore();
	patchSlice(store, 'sim', { phase: 3 });
	const sim = { store, getPhase: () => store.getState().sim.phase, setPhase: (phase: number) => patchSlice(store, 'sim', { phase }) };
	render(
		<SimHostProvider host={fakeHost({ sim })}>
			<PhaseSelector />
		</SimHostProvider>,
	);
	return { store, select: within(screen.getByTestId('phase-selector')).getByRole('combobox') as HTMLSelectElement };
};

describe('PhaseSelector', () => {
	it('shows the page’s phase and writes a new one to the sim', () => {
		const { store, select } = mount();
		expect(select.value).toBe('3');
		expect(select.options).toHaveLength(5);

		act(() => {
			fireEvent.change(select, { target: { value: '4' } });
		});
		expect(store.getState().sim.phase).toBe(4);
	});

	it('follows a phase change made elsewhere on the page', () => {
		const { store, select } = mount();
		act(() => patchSlice(store, 'sim', { phase: 2 }));
		expect(select.value).toBe('2');
	});
});
