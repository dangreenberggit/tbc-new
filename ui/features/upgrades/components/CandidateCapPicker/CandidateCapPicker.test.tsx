import i18n from '@i18n/config';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { CandidateCapPicker } from './CandidateCapPicker';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

const picker = () => screen.getByTestId('upgrades-candidates-picker');
const input = () => within(picker()).getByRole('textbox', { hidden: true }) as HTMLInputElement;

describe('CandidateCapPicker', () => {
	it('stays in the page while hidden, so the desktop gate can write it', () => {
		const onCapChange = vi.fn();
		render(<CandidateCapPicker capField={{ current: 0 }} onCapChange={onCapChange} hidden />);
		expect(picker().parentElement?.hidden).toBe(true);
		expect(input().value).toBe('');

		act(() => {
			fireEvent.change(input(), { target: { value: '40' } });
		});
		expect(onCapChange).toHaveBeenCalledWith(40);
	});

	it('shows under the dev flag, with the cap it holds', () => {
		render(<CandidateCapPicker capField={{ current: 10 }} onCapChange={() => {}} hidden={false} />);
		expect(picker().parentElement?.hidden).toBe(false);
		expect(input().value).toBe('10');
	});
});
