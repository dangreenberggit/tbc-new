import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { substitutionsFromMetaRepair } from '../../model/engine/disclosure';
import {
	breakSplitSkipSubstitution,
	candidateSkipSubstitution,
	hitCapFullWeightNote,
	hitCapPerSpellTalentNote,
	hitCapUnknownNote,
	metaPreferenceDisclosure,
	offHandBlockedDisclosure,
	oneHandBlockedDisclosure,
	SET_BONUS_SKIP_REASONS,
	setBonusesSkipSubstitution,
	setBonusSkipSubstitution,
	setScreenSkipSubstitution,
	uniqueSubstitutions,
	wornSetSkipSubstitution,
} from '../../model/engine/rank';
import type { DetectedSpecId } from '../../model/engine/types';
import { RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { SubstitutionsList } from './SubstitutionsList';

loadEnglishBundles({ character: true });

const terms = () =>
	within(screen.getByTestId('upgrades-substitutions'))
		.getAllByRole('term')
		.map(term => term.textContent);
/** Each cell's lines: the tab's sentence, then the failed call's error when it has one. */
const cellLines = () =>
	within(screen.getByTestId('upgrades-substitutions'))
		.getAllByRole('definition')
		.map(definition => [...definition.children].map(line => line.textContent));

describe('SubstitutionsList', () => {
	it('lists each left-out item with the first line of the reason the engine gave', () => {
		render(<SubstitutionsList substitutions={RANKING_FIXTURE.substitutions} />);

		expect(screen.getByText(`Items left out and other notes (${RANKING_FIXTURE.substitutions.length})`)).toBeTruthy();
		expect(terms()).toEqual(['Warglaive of Azzinoth (Main Hand)']);
		expect(cellLines()).toEqual([
			['This item was not ranked in this slot, because its sim failed.', 'panic: runtime error (full text in the browser console)'],
		]);
	});

	// Ticket 874: the failed call's own error shows under the tab's sentence, its first line only.
	it("shows a failed call's error on a second line, in every state of the error", () => {
		const sentence = 'The Justicar Battlegear 2-piece set bonus was not measured, because its sim failed.';
		const line = (error?: string) => ({ field: 'Justicar Battlegear 2-piece set bonus', detail: sentence, ...(error === undefined ? {} : { error }) });
		const long = `HTTP 500 from /raidSimAsync: ${'x'.repeat(300)}`;
		const cases: Array<[string | undefined, string[]]> = [
			['HTTP 500 from /raidSimAsync: injected failure', [sentence, 'HTTP 500 from /raidSimAsync: injected failure']],
			[long, [sentence, long]],
			['panic: boom\nStack Trace:\ngoroutine 7 [running]:', [sentence, 'panic: boom (full text in the browser console)']],
			['panic: boom\\ngoroutine 7', [sentence, 'panic: boom (full text in the browser console)']],
			['\npanic: boom', [sentence, 'panic: boom']],
			['', [sentence]],
			['  \n ', [sentence]],
			[undefined, [sentence]],
		];
		for (const [error, lines] of cases) {
			const { unmount } = render(<SubstitutionsList substitutions={[line(error)]} />);
			expect(cellLines()).toEqual([lines]);
			unmount();
		}
	});

	it('cuts a trace whose line breaks are written out as backslash-n', () => {
		render(
			<SubstitutionsList
				substitutions={[{ field: 'candidate 30900', detail: 'sim panicked: index out of range\ngoroutine 1 [running]:\nmain.go:12' }]}
			/>,
		);
		expect(cellLines()).toEqual([['sim panicked: index out of range (full text in the browser console)']]);
	});

	// A Go panic's error ends in a stack trace whose goroutine number and argument addresses change from sim to sim.
	it('shows a failed sim\'s line once when only the stack trace differs between the sims', () => {
		const failed = (goroutine: number) =>
			setBonusSkipSubstitution({
				setName: 'Justicar Battlegear',
				threshold: 4,
				reason: SET_BONUS_SKIP_REASONS.rowSimsFailed(`interface conversion: panic\nStack Trace:\ngoroutine ${goroutine} [running]:`),
				onSomeRows: true,
			});
		render(<SubstitutionsList substitutions={uniqueSubstitutions([failed(41), failed(57)])} />);
		expect(cellLines()).toEqual([
			['The Justicar Battlegear 4-piece set bonus was not measured on some rows, because their sim failed.', 'interface conversion: panic (full text in the browser console)'],
		]);
	});

	it('leaves a one-line reason whole', () => {
		render(<SubstitutionsList substitutions={[{ field: 'hit cap', detail: 'Kept the worn hit gems.' }]} />);
		expect(within(screen.getByTestId('upgrades-substitutions')).getByRole('definition').textContent).toBe('Kept the worn hit gems.');
	});

	// Ticket 704: every line the engine writes, built by the engine's own
	// functions, with ids, raw errors and the spec id after the line break.
	it('shows every engine line as one plain sentence', () => {
		// The console note goes inside the cut sentence's full stop.
		const inConsole = (sentence: string) => `${sentence.slice(0, -1)} (full text in the browser console).`;
		const ring = { itemId: 29283, name: 'Violet Signet of the Master Assassin', reason: 'panic: runtime error' };
		const setBonus = { setName: 'Justicar Battlegear', threshold: 4 as const };
		render(
			<SubstitutionsList
				substitutions={[
					...substitutionsFromMetaRepair([{ itemId: 30987, itemIndex: 0, socketIndex: 1, from: 24027, to: 24054, cost: 1 }]),
					hitCapUnknownNote(),
					hitCapFullWeightNote(),
					hitCapPerSpellTalentNote('Suppression'),
					// No real spec reaches this line; the cast stands in for a spec added without a meta gem entry.
					...metaPreferenceDisclosure('unlisted-spec' as DetectedSpecId),
					...oneHandBlockedDisclosure(2),
					...offHandBlockedDisclosure(1),
					candidateSkipSubstitution({ ...ring, kind: 'sim', slot: 'finger1' }),
					candidateSkipSubstitution({ ...ring, kind: 'sim', slot: 'finger2' }),
					candidateSkipSubstitution({
						kind: 'repair',
						itemId: 32461,
						name: 'Furious Gizmatic Goggles',
						slot: 'head',
						reason: 'no gem layout activates meta 32409',
					}),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.simFailed('sim error: boom') }),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.metaOff('no gem layout activates meta 32409') }),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.rowSimsFailed('sim error: boom'), onSomeRows: true }),
					breakSplitSkipSubstitution({ ...setBonus, error: 'sim error: boom' }),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.measuringSimsNotBuilt }),
					setScreenSkipSubstitution({ setName: 'Justicar Battlegear', error: 'sim error: boom' }),
					wornSetSkipSubstitution({ setName: 'Justicar Battlegear', error: 'sim error: boom' }),
					setBonusesSkipSubstitution({ setName: 'Justicar Battlegear', reason: SET_BONUS_SKIP_REASONS.bonusListFailed('computeStats error: boom') }),
					setBonusesSkipSubstitution({ setName: 'Justicar Battlegear', reason: SET_BONUS_SKIP_REASONS.metaOff('no gem layout activates meta 32409') }),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.notBuilt('the request database has no row for item 30987') }),
					setScreenSkipSubstitution({ setName: 'Justicar Battlegear', error: 'the request database has no row for item 30987', notBuilt: true }),
					setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.rowsNotBuilt('the request database has no row for item 30987'), onSomeRows: true }),
					breakSplitSkipSubstitution({ ...setBonus, error: 'the request database has no row for item 30987', notBuilt: true }),
					wornSetSkipSubstitution({ setName: 'Justicar Battlegear', error: 'the request database has no row for item 30987', notBuilt: true }),
					setBonusesSkipSubstitution({
						setName: 'Justicar Battlegear',
						reason: SET_BONUS_SKIP_REASONS.bonusListNotBuilt('the request database has no row for item 30987'),
					}),
				]}
			/>,
		);
		expect(terms()).toEqual([
			'Meta gem',
			'Meta gem swaps and the hit cap',
			'Meta gem swaps and the hit cap',
			'Meta gem swaps and the hit cap',
			'Meta gem for your spec',
			'One-handed weapons',
			'Off-hand items',
			'Violet Signet of the Master Assassin (Ring 1)',
			'Violet Signet of the Master Assassin (Ring 2)',
			'Furious Gizmatic Goggles (Head)',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear set',
			'Justicar Battlegear set',
			'Justicar Battlegear set',
			'Justicar Battlegear set',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear set',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear 4-piece set bonus',
			'Justicar Battlegear set',
			'Justicar Battlegear set',
		]);
		const boom = 'sim error: boom';
		const noRow = 'the request database has no row for item 30987';
		const noLayout = 'no gem layout activates meta 32409';
		expect(cellLines()).toEqual([
			[inConsole(`Your meta gem was not active, so the ranking swapped 1 gem in its own copy of your gear to turn it on; your gear itself was not changed.`)],
			['If gems were swapped to turn your meta gem on, hit rating was treated as always useful, because this tab works out the hit cap only when every target is level 73.'],
			['If gems were swapped to turn your meta gem on, hit rating was counted at full value, with no hit cap applied for this spec.'],
			['If gems were swapped to turn your meta gem on, hit rating was valued as if your Suppression talent added no hit, so it may be valued too high.'],
			[inConsole(`The ranking does not know which meta gem your spec uses, so new items with a meta socket got the meta gem you wear, or an empty socket and no socket bonus if you wear none.`)],
			['2 one-handed weapons were not ranked, because you wear a two-handed weapon.'],
			['1 off-hand item was not ranked, because you wear a two-handed weapon.'],
			['This item was not ranked in this slot, because its sim failed.', 'panic: runtime error (full text in the browser console)'],
			['This item was not ranked in this slot, because its sim failed.', 'panic: runtime error (full text in the browser console)'],
			[
				'This item was not ranked in this slot, because no gem swap could turn your meta gem on with it equipped.',
				`${noLayout} (full text in the browser console)`,
			],
			['The Justicar Battlegear 4-piece set bonus was not measured, because its sim failed.', boom],
			['The Justicar Battlegear 4-piece set bonus was not measured, because no gem swap could turn your meta gem on.', noLayout],
			['The Justicar Battlegear 4-piece set bonus was not measured on some rows, because their sim failed.', boom],
			[
				'On some rows, the cost of breaking the Justicar Battlegear 4-piece set bonus was not measured apart from the pieces that break it, because their sim failed.',
				boom,
			],
			['The Justicar Battlegear 4-piece set bonus was not measured, because the sims that measure it could not be built.'],
			["The Justicar Battlegear set was kept without the quick check that can skip it, because the check's sim failed.", boom],
			['The value of the Justicar Battlegear set on your gear was not fully measured, because its sim failed.', boom],
			["The Justicar Battlegear set bonuses were not all measured, because the sim could not list the set's bonuses.", 'computeStats error: boom'],
			['The Justicar Battlegear set bonuses were not all measured, because no gem swap could turn your meta gem on.', noLayout],
			['The Justicar Battlegear 4-piece set bonus was not measured, because the sims that measure it could not be built.', noRow],
			["The Justicar Battlegear set was kept without the quick check that can skip it, because the check's sim could not be built.", noRow],
			['The Justicar Battlegear 4-piece set bonus was not measured on some rows, because their sims could not be built.', noRow],
			[
				'On some rows, the cost of breaking the Justicar Battlegear 4-piece set bonus was not measured apart from the pieces that break it, because their sim could not be built.',
				noRow,
			],
			['The value of the Justicar Battlegear set on your gear was not fully measured, because its sim could not be built.', noRow],
			["The Justicar Battlegear set bonuses were not all measured, because the check that lists the set's bonuses could not be built.", noRow],
		]);
		// The tab's own words: the label and each cell's first line. The second line is the call's error, word for word.
		expect([...terms(), ...cellLines().map(([sentence]) => sentence)].join(' ')).not.toMatch(
			/\d{4,}|\bEP\b|repair|candidate|priced|\bpool\b|worker died|panic|unlisted/i,
		);
	});
});
