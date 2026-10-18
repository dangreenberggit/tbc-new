import { describe, expect, it } from 'vitest';

import { dbPoolFor } from '../testing/db_pool';
import { fixtureRow } from '../testing/ranking_fixture';
import { exportIdForRow, exportPayload } from './export';

const greaves = fixtureRow(9);
const breastplate = fixtureRow(4);
const trophy = fixtureRow(7);

describe('exportIdForRow', () => {
	it('gives the tier token that drops for a token row, under the token flavour', () => {
		expect(exportIdForRow(greaves, 'token')).toBe(31098);
	});

	it('gives the gear id under the gear flavour', () => {
		expect(exportIdForRow(greaves, 'gear')).toBe(30993);
	});

	it('falls back to the gear id when the token source carries no token id', () => {
		expect(exportIdForRow(breastplate, 'token')).toBe(30990);
	});

	it('gives the gear id for a row with no token source', () => {
		expect(exportIdForRow(fixtureRow(0), 'token')).toBe(32332);
	});

	it('gives the token id tier-exchange.json names for a tier piece in the run-time pool', () => {
		const justicarCrown = dbPoolFor('ret', 3).find(e => e.itemId === 29073);
		expect(justicarCrown && exportIdForRow(justicarCrown, 'token')).toBe(29760);
	});
});

describe('exportPayload', () => {
	it('lists the rows in the order given, leaving owned rows out', () => {
		expect(exportPayload([fixtureRow(1), trophy, greaves, fixtureRow(0)], 'token')).toEqual({ items: [{ id: 30902 }, { id: 31098 }, { id: 32332 }] });
	});

	it('lists two rows that emit the same id once', () => {
		const ringInOtherFinger = { ...fixtureRow(0), slotChoice: 'offhand' as const };
		expect(exportPayload([fixtureRow(0), ringInOtherFinger], 'gear')).toEqual({ items: [{ id: 32332 }] });
	});

	it('is a well-formed empty list when every row is owned', () => {
		expect(exportPayload([trophy], 'gear')).toEqual({ items: [] });
	});
});
