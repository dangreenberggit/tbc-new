import { GemColor } from '@generated/proto/common';
import { describe, expect, it, vi } from 'vitest';

import { metaDeficit, socketBonusActive } from './meta';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe('socket bonus follows the sim', () => {
	// Gladiator's Plate Helm's sockets.
	const META_YELLOW = [GemColor.GemColorMeta, GemColor.GemColorYellow];

	it('socketBonusActive withholds the bonus for an empty meta socket beside a matched yellow socket', () => {
		expect(socketBonusActive(META_YELLOW, [0, 23113])).toBe(false);
		expect(socketBonusActive(META_YELLOW, [32409, 23113])).toBe(true);
	});
});

describe('meta deficit', () => {
	// Mystical Skyfire Diamond: more blue gems than yellow.
	const MYSTICAL_SKYFIRE = 25893;

	it('a more-blue-than-yellow meta is short by the gap plus one', () => {
		expect(metaDeficit(MYSTICAL_SKYFIRE, { red: 0, yellow: 2, blue: 2 })).toBe(1);
		expect(metaDeficit(MYSTICAL_SKYFIRE, { red: 0, yellow: 3, blue: 1 })).toBe(3);
		expect(metaDeficit(MYSTICAL_SKYFIRE, { red: 0, yellow: 1, blue: 2 })).toBe(0);
	});
});
