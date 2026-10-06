import i18n from '@i18n/config';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { FixtureFileInput } from './FixtureFileInput';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterEach(() => {
	vi.unstubAllGlobals();
	delete window.__upgradesFixture;
});

const choose = (text: string) => {
	const input = screen.getByTestId('upgrades-fixture-file');
	fireEvent.change(input, { target: { files: [new File([text], 'fixture.json', { type: 'application/json' })] } });
};

describe('FixtureFileInput', () => {
	it('renders nothing in a build without fixtures', () => {
		expect(render(<FixtureFileInput />).container.innerHTML).toBe('');
	});

	it('hands a chosen file to the page’s fixture hook and says how many rows it loaded', async () => {
		vi.stubGlobal('__TBC_TAB_FIXTURES__', true);
		const load = vi.fn().mockResolvedValue({ ok: true, rows: 467 });
		window.__upgradesFixture = load;
		render(<FixtureFileInput />);

		choose('{"schemaVersion":1}');
		await waitFor(() => expect(screen.getByTestId('upgrades-fixture-file-result').textContent).toBe('Loaded a fixture with 467 rows.'));
		expect(load).toHaveBeenCalledWith({ schemaVersion: 1 });
	});

	it('says why the hook rejected a file', async () => {
		vi.stubGlobal('__TBC_TAB_FIXTURES__', true);
		window.__upgradesFixture = vi.fn().mockResolvedValue({ ok: false, reason: 'spec', detail: 'fixture is feral, page is ret' });
		render(<FixtureFileInput />);

		choose('{}');
		await waitFor(() => expect(screen.getByTestId('upgrades-fixture-file-result').textContent).toBe('Fixture rejected: fixture is feral, page is ret'));
	});

	it('says a file that is not JSON is not JSON, without calling the hook', async () => {
		vi.stubGlobal('__TBC_TAB_FIXTURES__', true);
		const load = vi.fn();
		window.__upgradesFixture = load;
		render(<FixtureFileInput />);

		choose('not json');
		await waitFor(() => expect(screen.getByTestId('upgrades-fixture-file-result').textContent).toBe('The file is not JSON.'));
		expect(load).not.toHaveBeenCalled();
	});
});
