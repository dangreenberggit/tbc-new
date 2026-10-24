import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { SubstitutionsList } from './SubstitutionsList';

loadEnglishBundles();

describe('SubstitutionsList', () => {
	it('lists each dropped candidate with the first line of the reason the engine gave', () => {
		render(<SubstitutionsList substitutions={RANKING_FIXTURE.substitutions} />);

		expect(screen.getByText(`Dropped candidates and substitutions (${RANKING_FIXTURE.substitutions.length})`)).toBeTruthy();
		const list = screen.getByTestId('upgrades-substitutions');
		expect(
			within(list)
				.getAllByRole('term')
				.map(term => term.textContent),
		).toEqual(['Warglaive of Azzinoth']);
		expect(
			within(list)
				.getAllByRole('definition')
				.map(definition => definition.textContent),
		).toEqual([
			'A sim of this item failed, so that try was left out of the ranking.… (full text in the browser console)',
		]);
	});

	it('cuts a trace whose line breaks are written out as backslash-n', () => {
		render(
			<SubstitutionsList
				substitutions={[{ field: 'candidate 30900', detail: 'sim panicked: index out of range\ngoroutine 1 [running]:\nmain.go:12' }]}
			/>,
		);
		expect(within(screen.getByTestId('upgrades-substitutions')).getByRole('definition').textContent).toBe(
			'sim panicked: index out of range… (full text in the browser console)',
		);
	});

	it('leaves a one-line reason whole', () => {
		render(<SubstitutionsList substitutions={[{ field: 'hit cap', detail: 'Kept the worn hit gems.' }]} />);
		expect(within(screen.getByTestId('upgrades-substitutions')).getByRole('definition').textContent).toBe('Kept the worn hit gems.');
	});

	// Ticket 704: the engine's exact strings, one per kind of line, with ids,
	// raw errors and the spec id after the line break.
	it('shows every engine line as one plain sentence', () => {
		const more = '… (full text in the browser console)';
		render(
			<SubstitutionsList
				substitutions={[
					{
						field: 'Meta gem',
						detail:
							'Your meta gem was not active, so the ranking swapped 1 gem in its own copy of your gear to turn it on; your gear itself was not changed.\nswaps: gem 24027 -> gem 24054 on item 30987',
					},
					{
						field: 'Meta gem and hit rating',
						detail:
							'If gems were swapped to turn your meta gem on, hit rating was treated as always useful, because the hit cap is only known for a fight where every target is level 73.',
					},
					{
						field: 'Meta gem and hit rating',
						detail: 'If gems were swapped to turn your meta gem on, hit rating was treated as always useful, because your hit rating could not be read.\nworker died',
					},
					{
						field: 'Meta gem and hit rating',
						detail: 'The set-bonus sims used the same gems at every piece count, because the hit rating of one of them could not be read.\nworker died',
					},
					{
						field: 'Meta gem',
						detail:
							'No meta gem is known for your spec, so meta sockets on candidate items were left empty and those items are priced without a meta gem and without their socket bonus.\nspec: ele',
					},
					{
						field: 'Warglaive of Azzinoth',
						detail: 'A sim of this item failed, so that try was left out of the ranking.\nitem 32837, slot mainhand: panic: runtime error',
					},
					{
						field: 'Justicar Battlegear 4-piece set bonus',
						detail: 'The Justicar Battlegear 4-piece set bonus was not measured, because its sim failed.\nsim error: boom',
					},
				]}
			/>,
		);
		const list = screen.getByTestId('upgrades-substitutions');
		expect(
			within(list)
				.getAllByRole('term')
				.map(term => term.textContent),
		).toEqual([
			'Meta gem',
			'Meta gem and hit rating',
			'Meta gem and hit rating',
			'Meta gem and hit rating',
			'Meta gem',
			'Warglaive of Azzinoth',
			'Justicar Battlegear 4-piece set bonus',
		]);
		const definitions = within(list)
			.getAllByRole('definition')
			.map(definition => definition.textContent);
		expect(definitions).toEqual([
			`Your meta gem was not active, so the ranking swapped 1 gem in its own copy of your gear to turn it on; your gear itself was not changed.${more}`,
			'If gems were swapped to turn your meta gem on, hit rating was treated as always useful, because the hit cap is only known for a fight where every target is level 73.',
			`If gems were swapped to turn your meta gem on, hit rating was treated as always useful, because your hit rating could not be read.${more}`,
			`The set-bonus sims used the same gems at every piece count, because the hit rating of one of them could not be read.${more}`,
			`No meta gem is known for your spec, so meta sockets on candidate items were left empty and those items are priced without a meta gem and without their socket bonus.${more}`,
			`A sim of this item failed, so that try was left out of the ranking.${more}`,
			`The Justicar Battlegear 4-piece set bonus was not measured, because its sim failed.${more}`,
		]);
		expect(definitions.join(' ')).not.toMatch(/\d{4,}|EP|min-EP|repair|worker died|panic|ele\b/);
	});
});
