import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fixtureRow } from '../../testing/ranking_fixture';
import { ExportPanel } from './ExportPanel';

loadEnglishBundles();

const TORCH = fixtureRow(0);
const DRAGONSPINE_OWNED = fixtureRow(7);
const GREAVES_TOKEN = fixtureRow(9);

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

	it('shows nothing when every row is owned', () => {
		const { container } = render(<ExportPanel rows={[DRAGONSPINE_OWNED]} />);
		expect(container.innerHTML).toBe('');
	});
});
