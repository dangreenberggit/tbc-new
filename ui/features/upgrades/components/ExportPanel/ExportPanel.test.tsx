import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fireEvent, render as renderInPage, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { upgradesStoreFor } from '../../hooks/useUpgradesStore';
import { setExportFlavour } from '../../model/upgrades_store';
import { fakeTabHost } from '../../testing/fake_tab_host';
import { fixtureRow } from '../../testing/ranking_fixture';
import { ExportPanel } from './ExportPanel';

loadEnglishBundles();

const TORCH = fixtureRow(0);
const DRAGONSPINE_OWNED = fixtureRow(7);
const GREAVES_TOKEN = fixtureRow(9);

/** A fresh page per case, so each case gets its own tab store. */
let host = fakeTabHost({ player: { getSpec: () => undefined } });
beforeEach(() => {
	host = fakeTabHost({ player: { getSpec: () => undefined } });
});
const render = (panel: ReactNode) => renderInPage(<SimHostProvider host={host}>{panel}</SimHostProvider>);

const exportedIds = () => {
	const area = screen.getByTestId<HTMLTextAreaElement>('upgrades-export-area');
	const payload: { items: Array<{ id: number }> } = JSON.parse(area.value);
	return payload.items.map(item => item.id);
};

describe('ExportPanel', () => {
	it('exports the tier token a tier piece drops from, skips owned rows, and keeps the order it is given', () => {
		render(<ExportPanel rows={[GREAVES_TOKEN, DRAGONSPINE_OWNED, TORCH]} />);

		expect(exportedIds()).toEqual([31098, TORCH.itemId]);
		expect(screen.getByTestId('upgrades-export-count').textContent).toBe('2 items');
		expect(screen.getByText('Exporting the token ID for tier pieces — the item that actually drops.')).toBeTruthy();
	});

	it('exports the gear item ids once the token flavour is turned off', () => {
		render(<ExportPanel rows={[GREAVES_TOKEN, TORCH]} />);
		fireEvent.click(screen.getByRole('checkbox'));

		expect(exportedIds()).toEqual([GREAVES_TOKEN.itemId, TORCH.itemId]);
		expect(screen.getByText('Exporting the gear item ID for every row.')).toBeTruthy();
	});

	// Ticket 588: the choice is saved with the tab's other settings, so it survives a reload.
	it('starts from the choice the page saved, and keeps a new one in the tab’s store', () => {
		const store = upgradesStoreFor(host);
		setExportFlavour(store, 'gear');
		render(<ExportPanel rows={[GREAVES_TOKEN, TORCH]} />);
		expect(exportedIds()).toEqual([GREAVES_TOKEN.itemId, TORCH.itemId]);

		fireEvent.click(screen.getByRole('checkbox'));
		expect(exportedIds()).toEqual([31098, TORCH.itemId]);
		expect(store.getState().exportFlavour).toBe('token');
	});

	it('shows nothing when every row is owned', () => {
		const { container } = render(<ExportPanel rows={[DRAGONSPINE_OWNED]} />);
		expect(container.innerHTML).toBe('');
	});
});
