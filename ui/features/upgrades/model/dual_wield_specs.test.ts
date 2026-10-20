import { PlayerSpecs } from '@sim/player/specs';
import { describe, expect, it } from 'vitest';

import { PROTO_SPEC } from '../testing/db_pool';
import { DUAL_WIELD_SPECS } from './engine/pool';
import type { SpecId } from './engine/types';

// Fork-added. The engine cannot load wowsims' PlayerSpec (the core parity test
// runs it without the fork's build), so it keeps its own list of specs that may
// put a one-hander in the off hand. This pins that list to wowsims' flag.
describe('DUAL_WIELD_SPECS', () => {
	const specs = Object.entries(PROTO_SPEC) as [SpecId, (typeof PROTO_SPEC)[SpecId]][];

	it('covers the eleven DPS specs the tab ranks', () => {
		expect(specs).toHaveLength(11);
	});

	it.each(specs)('agrees with wowsims canDualWield for %s', (specId, protoSpec) => {
		expect(DUAL_WIELD_SPECS.has(specId)).toBe(PlayerSpecs.fromProto(protoSpec).canDualWield);
	});
});
