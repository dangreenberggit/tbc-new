/**
 * Meta repair rules on small hand-built gear, each expected layout worked out by hand
 * from the item and gem rows in db.json. Items are listed head first, as
 * `repairMetaGems` reads them; which slot an item is worn in does not matter here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GemEntry, getGem } from './gems';
import { repairMetaGems, type SocketedItem } from './meta-repair';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Gems: color, stats.
const BOLD = 24027; // red, str 8
const RIGID = 24051; // yellow, hit 8
const SOLID = 24033; // blue, sta 12
const INSCRIBED = 24058; // orange, str 4 crit 4
const SOVEREIGN = 24054; // purple, str 4 sta 6
const JAGGED = 24067; // green, sta 6 crit 4
const STONE_OF_BLADES = 33143; // yellow, crit 12, unique

// Metas.
const SWIFT_SKYFIRE = 25894; // at least 1 red and 2 yellow
const RELENTLESS = 32409; // at least 2 red, 2 yellow and 2 blue
const MYSTICAL_SKYFIRE = 25893; // more blue than yellow

// Heads with one meta socket and no other.
const PLATE_HELM = 28559;
const CHAIN_HELM = 28576;

// Items: sockets, socket bonus.
const JUSTICAR_SHOULDERS = 29075; // [yellow, red], hit 3
const BRACERS_OF_HAVOK = 24250; // [yellow], spell crit 2
const SHATARI_ARMGUARDS = 28167; // [yellow], sta 3
const STRANGER_SHOULDERPADS = 30055; // [red], agi 2
const DESTROYER_GREAVES = 30121; // [red], crit 2
const ONSLAUGHT_GAUNTLETS = 30969; // [red], crit 2
const SHATTRATH_WRAPS = 28174; // [red], sta 3
const DESTROYER_LEGGUARDS = 30116; // [red], sta 3
const AUCHENAI_BRACERS = 28170; // [red], stat 35

const STR = '0';
const STA = '2';
const HIT = '20';
const CRIT = '21';

const gems = (...ids: number[]): GemEntry[] => ids.map(id => getGem(id)!);

afterEach(() => {
	vi.restoreAllMocks();
});

describe('exact meta repair', () => {
	it('of two sockets that give the same colors, recolors the one that switches the socket bonus on', () => {
		// Red 2, yellow 1: Swift Skyfire is one yellow short. A Rigid in either
		// shoulder socket turns it on, and Rigid and Bold are worth 8 each, so
		// only the bonus tells them apart: Rigid in the yellow socket matches
		// both sockets and switches on hit 3; Rigid in the red socket gives 0.
		const items: SocketedItem[] = [
			{ itemId: PLATE_HELM, gems: [SWIFT_SKYFIRE] },
			{ itemId: JUSTICAR_SHOULDERS, gems: [BOLD, BOLD] },
			{ itemId: BRACERS_OF_HAVOK, gems: [RIGID] },
		];
		const out = repairMetaGems({ items, epWeights: { [STR]: 1, [HIT]: 1 }, allowedGems: gems(BOLD, RIGID) });
		expect(out.items.map(it => it.gems)).toEqual([[SWIFT_SKYFIRE], [RIGID, BOLD], [RIGID]]);
		expect(out.recolors).toEqual([{ itemId: JUSTICAR_SHOULDERS, itemIndex: 1, socketIndex: 0, from: BOLD, to: RIGID }]);
	});

	it('places a unique gem once, though it would be worth more on two items', () => {
		// Red 3, yellow 0: Swift Skyfire needs two yellows, so two Bolds become
		// yellow. Stone of Blades (crit 12) beats Rigid (hit 8) by 4, but it is
		// unique: one Stone and one Rigid. The lost socket bonuses (agi, sta) are
		// weighted 0.
		const items: SocketedItem[] = [
			{ itemId: PLATE_HELM, gems: [SWIFT_SKYFIRE] },
			{ itemId: STRANGER_SHOULDERPADS, gems: [BOLD] },
			{ itemId: SHATTRATH_WRAPS, gems: [BOLD] },
			{ itemId: DESTROYER_LEGGUARDS, gems: [BOLD] },
		];
		const out = repairMetaGems({
			items,
			epWeights: { [STR]: 1, [HIT]: 1, [CRIT]: 1 },
			allowedGems: gems(BOLD, RIGID, STONE_OF_BLADES),
		});
		expect(out.recolors).toHaveLength(2);
		expect(out.items.flatMap(it => it.gems).sort((a, b) => a - b)).toEqual([BOLD, RIGID, SWIFT_SKYFIRE, STONE_OF_BLADES].sort((a, b) => a - b));
	});
});

describe('meta repair past the work limit', () => {
	const warnOnce = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

	it('drops a greedy recolor the meta no longer needs, and keeps the one it does', () => {
		// Red 3, yellow 1, blue 1: Relentless is one yellow and one blue short.
		// Values (str, sta, hit at 1; crit 0): Bold 8, Rigid 8, Solid 12,
		// Sovereign 10, Jagged 6, Inscribed 4; every socket bonus here is 0.
		// Greedy's first move is the cheapest that lowers the deficit: Bold to
		// Sovereign on the first red item, cost 8 − 10 = −2. Its second is Bold to
		// Jagged on the second, cost 8 − 6 = 2, which turns the meta on at red 2,
		// yellow 2, blue 2. Undoing the first then still leaves red 2, yellow 2,
		// blue 2, so it is dropped; undoing the second does not, so it stays.
		const warn = warnOnce();
		const items: SocketedItem[] = [
			{ itemId: CHAIN_HELM, gems: [RELENTLESS] },
			{ itemId: STRANGER_SHOULDERPADS, gems: [BOLD] },
			{ itemId: DESTROYER_GREAVES, gems: [BOLD] },
			{ itemId: ONSLAUGHT_GAUNTLETS, gems: [BOLD] },
			{ itemId: BRACERS_OF_HAVOK, gems: [RIGID] },
			{ itemId: AUCHENAI_BRACERS, gems: [SOLID] },
		];
		const out = repairMetaGems({
			items,
			epWeights: { [STR]: 1, [STA]: 1, [HIT]: 1 },
			allowedGems: gems(INSCRIBED, SOVEREIGN, JAGGED),
			workLimit: 1,
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(out.items.map(it => it.gems)).toEqual([[RELENTLESS], [BOLD], [JAGGED], [BOLD], [RIGID], [SOLID]]);
		expect(out.recolors).toEqual([{ itemId: DESTROYER_GREAVES, itemIndex: 2, socketIndex: 0, from: BOLD, to: JAGGED }]);
	});

	it('repairs a more-blue-than-yellow meta at equal blue and yellow', () => {
		// Yellow 1, blue 1: Mystical Skyfire needs more blue than yellow, one
		// recolor short. Rigid to Solid gives yellow 0, blue 2, at cost 8 − 12.
		warnOnce();
		const items: SocketedItem[] = [
			{ itemId: PLATE_HELM, gems: [MYSTICAL_SKYFIRE] },
			{ itemId: BRACERS_OF_HAVOK, gems: [RIGID] },
			{ itemId: SHATARI_ARMGUARDS, gems: [SOLID] },
		];
		const out = repairMetaGems({
			items,
			epWeights: { [STA]: 1, [HIT]: 1 },
			allowedGems: gems(RIGID, SOLID),
			workLimit: 1,
		});
		expect(out.items.map(it => it.gems)).toEqual([[MYSTICAL_SKYFIRE], [SOLID], [SOLID]]);
		expect(out.recolors).toEqual([{ itemId: BRACERS_OF_HAVOK, itemIndex: 1, socketIndex: 0, from: RIGID, to: SOLID }]);
	});
});
