import i18n from '@i18n/config';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { CandidateCapPicker } from './CandidateCapPicker';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

const input = () => within(screen.getByTestId('upgrades-candidates-picker')).getByRole('textbox') as HTMLInputElement;

describe('CandidateCapPicker', () => {
	it('shows no cap as an empty field, and reports a typed cap', () => {
		const onCapChange = vi.fn();
		render(<CandidateCapPicker capField={{ current: 0 }} onCapChange={onCapChange} />);
		expect(input().value).toBe('');

		act(() => {
			fireEvent.change(input(), { target: { value: '40' } });
		});
		expect(onCapChange).toHaveBeenCalledWith(40);
	});

	it('shows the cap it holds', () => {
		render(<CandidateCapPicker capField={{ current: 10 }} onCapChange={() => {}} />);
		expect(input().value).toBe('10');
	});
});
