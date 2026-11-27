/**
 * One candidate swapped into hand-built gear (`candidateSwapWithRepairs`): which recolors
 * it reports, which enchant the new item keeps, and when a two-hander clears the off
 * hand. Expected gear is worked out by hand from the item rows in db.json.
 */

import { describe, expect, it, vi } from 'vitest';

import { gemContext } from './candidate-gems';
import { candidateSwapWithRepairs } from './gear-swap';
import { getGem } from './gems';
import { SIM_ORDER, type SimItemSpec } from './slots';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const HEAD = SIM_ORDER.indexOf('head');
const SHOULDER = SIM_ORDER.indexOf('shoulder');
const WRIST = SIM_ORDER.indexOf('wrist');
const MAINHAND = SIM_ORDER.indexOf('mainhand');
const OFFHAND = SIM_ORDER.indexOf('offhand');

const BOLD = 24027; // red, str 8
const RIGID = 24051; // yellow, hit 8
const SWIFT_SKYFIRE = 25894; // at least 1 red and 2 yellow

const PLATE_HELM = 28559; // [meta]
const JUSTICAR_SHOULDERS = 29075; // [yellow, red], bonus hit 3
const SOULCLOTH_SHOULDERS = 21864; // [yellow, red], bonus int 3
const BRACERS_OF_HAVOK = 24250; // [yellow]
const SHATARI_ARMGUARDS = 28167; // [yellow]

// Weapons with no sockets.
const BLACKBLADE = 12592; // two-handed sword
const RUNEBLADE = 13505; // two-handed sword
const TEEBUS_LONGSWORD = 1728; // one-handed sword
const GRAND_MARSHALS_LONGSWORD = 12584; // one-handed sword
const SKULLFLAME_SHIELD = 1168; // shield, held in the off hand

const MAJOR_AGILITY_2H = 2670; // Enchant 2H Weapon - Major Agility

/** A 17-slot gear, empty except the given slots. */
function gear(filled: Record<number, SimItemSpec>): SimItemSpec[] {
	return SIM_ORDER.map((_, i) => filled[i] ?? { gems: [] });
}

const strAndHit = gemContext([getGem(BOLD)!, getGem(RIGID)!], { '0': 1, '20': 1 });

describe('recolors a swap reports', () => {
	it('leaves out a recolor inside the swapped item, though the gear was repaired', () => {
		// The Justicar Shoulderplates take the worn shoulders' two Bolds (the
		// red socket first, then the free yellow one). Red 2, yellow 1 leaves
		// Swift Skyfire one yellow short; the repair puts Rigid in the yellow
		// socket, which also switches the hit 3 bonus on.
		const worn = gear({
			[HEAD]: { id: PLATE_HELM, gems: [SWIFT_SKYFIRE] },
			[SHOULDER]: { id: SOULCLOTH_SHOULDERS, gems: [BOLD, BOLD] },
			[WRIST]: { id: BRACERS_OF_HAVOK, gems: [RIGID] },
		});
		const out = candidateSwapWithRepairs(worn, SHOULDER, JUSTICAR_SHOULDERS, strAndHit);
		expect(out.equipment[SHOULDER]).toEqual({ id: JUSTICAR_SHOULDERS, gems: [RIGID, BOLD] });
		expect(out.repaired).toBe(true);
		expect(out.recolors).toEqual([]);
	});

	it('lists a recolor in another worn item', () => {
		// The Sha'tari Wrought Armguards take the worn wrist's Rigid; the same
		// repair now falls on the worn shoulders.
		const worn = gear({
			[HEAD]: { id: PLATE_HELM, gems: [SWIFT_SKYFIRE] },
			[SHOULDER]: { id: JUSTICAR_SHOULDERS, gems: [BOLD, BOLD] },
			[WRIST]: { id: BRACERS_OF_HAVOK, gems: [RIGID] },
		});
		const out = candidateSwapWithRepairs(worn, WRIST, SHATARI_ARMGUARDS, strAndHit);
		expect(out.equipment[SHOULDER]).toEqual({ id: JUSTICAR_SHOULDERS, gems: [RIGID, BOLD] });
		expect(out.recolors).toEqual([{ itemId: JUSTICAR_SHOULDERS, itemIndex: SHOULDER, socketIndex: 0, from: BOLD, to: RIGID }]);
	});
});

describe('enchant on the swapped item', () => {
	const worn = gear({ [MAINHAND]: { id: BLACKBLADE, gems: [], enchant: MAJOR_AGILITY_2H } });

	it('a one-hander does not keep a two-hand-only enchant', () => {
		const out = candidateSwapWithRepairs(worn, MAINHAND, TEEBUS_LONGSWORD, strAndHit);
		expect(out.equipment[MAINHAND]).toEqual({ id: TEEBUS_LONGSWORD, gems: [] });
	});

	it('another two-hander keeps it', () => {
		const out = candidateSwapWithRepairs(worn, MAINHAND, RUNEBLADE, strAndHit);
		expect(out.equipment[MAINHAND]).toEqual({ id: RUNEBLADE, gems: [], enchant: MAJOR_AGILITY_2H });
	});
});

describe('off hand under a main-hand swap', () => {
	const worn = gear({
		[MAINHAND]: { id: TEEBUS_LONGSWORD, gems: [] },
		[OFFHAND]: { id: SKULLFLAME_SHIELD, gems: [] },
	});

	it('a two-hander empties the off hand and reports the item it took off', () => {
		const out = candidateSwapWithRepairs(worn, MAINHAND, BLACKBLADE, strAndHit);
		expect(out.equipment[MAINHAND]).toEqual({ id: BLACKBLADE, gems: [] });
		expect(out.equipment[OFFHAND]).toEqual({ gems: [] });
		expect(out.removed).toEqual([{ slotIndex: OFFHAND, itemId: SKULLFLAME_SHIELD }]);
	});

	it('a one-hander leaves the off hand on', () => {
		const out = candidateSwapWithRepairs(worn, MAINHAND, GRAND_MARSHALS_LONGSWORD, strAndHit);
		expect(out.equipment[OFFHAND]).toEqual({ id: SKULLFLAME_SHIELD, gems: [] });
		expect(out.removed).toEqual([]);
	});
});
