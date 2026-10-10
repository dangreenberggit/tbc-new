import { fakeTabHost } from '@features/upgrades/testing/fake_tab_host';
import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore } from '@sim/state/sim_store';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The tab's code fails to download, as a network error or a removed chunk would make it. A file of its own, because
// `lazy` keeps the first outcome for the page's life and `UpgradesTabBody.test.tsx` needs the import to succeed.
vi.mock('@features/upgrades/components/UpgradesTab', () => {
	throw new Error('Failed to fetch dynamically imported module');
});

const { UpgradesTabBody } = await import('./UpgradesTabBody');

loadEnglishBundles();

describe('UpgradesTabBody when its code fails to load', () => {
	it('shows a reload message in the pane and leaves the rest of the page mounted', async () => {
		// React reports the caught error on the console; the test expects it.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		render(
			<SimHostProvider host={fakeTabHost({ sim: { store: createSimStore() } })}>
				<div>
					<p data-testid="other-tab">Gear</p>
					<UpgradesTabBody />
				</div>
			</SimHostProvider>,
		);

		const message = await screen.findByTestId('upgrades-tab-load-failed');
		expect(message.textContent).toBe('The Upgrades tab could not load. Reload the page to try again.');
		expect(message.getAttribute('role')).toBe('alert');
		expect(screen.getByTestId('other-tab').textContent).toBe('Gear');
		error.mockRestore();
	});
});
