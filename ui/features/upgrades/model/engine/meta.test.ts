import { GemColor } from '@generated/proto/common';
import { describe, expect, it, vi } from 'vitest';

import { socketBonusActive } from './meta';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe('socket bonus follows the sim', () => {
	// Gladiator's Plate Helm's sockets.
	const META_YELLOW = [GemColor.GemColorMeta, GemColor.GemColorYellow];

	it('socketBonusActive withholds the bonus for an empty meta socket beside a matched yellow socket', () => {
		expect(socketBonusActive(META_YELLOW, [0, 23113])).toBe(false);
		expect(socketBonusActive(META_YELLOW, [32409, 23113])).toBe(true);
	});
});
