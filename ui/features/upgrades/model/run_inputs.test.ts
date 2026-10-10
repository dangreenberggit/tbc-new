import { Player as PlayerProto, Raid as RaidProto } from '@generated/proto/api';
import { Encounter as EncounterProto, EquipmentSpec, ItemSpec } from '@generated/proto/common';
import { SimDatabase, SimItem } from '@generated/proto/db';
import { describe, expect, it } from 'vitest';

import { inputsSignature, liveInputsKey, type LiveInputsSource } from './run_inputs';
import type { RunSettings } from './run_state';

/**
 * A page with one player wearing `itemIds`. Like the real `Player.toProto`, the
 * player proto carries the item database unless it is asked for the export form.
 */
const page = (itemIds: number[], phase = 3): LiveInputsSource => ({
	raid: {
		toProto: forExport =>
			RaidProto.create({
				parties: [
					{
						players: [
							PlayerProto.create({
								equipment: EquipmentSpec.create({ items: itemIds.map(id => ItemSpec.create({ id })) }),
								database: forExport ? undefined : SimDatabase.create({ items: itemIds.map(id => SimItem.create({ id })) }),
							}),
						],
					},
				],
			}),
	},
	encounter: { toProto: () => EncounterProto.create({ duration: 180 }) },
	getPhase: () => phase,
});

describe('liveInputsKey', () => {
	it('is the same for the same page', () => {
		expect(liveInputsKey(page([30129, 32461]))).toBe(liveInputsKey(page([30129, 32461])));
	});

	it('changes when a gear slot changes', () => {
		expect(liveInputsKey(page([30129, 32461]))).not.toBe(liveInputsKey(page([30129, 30022])));
	});

	it('changes when the phase changes', () => {
		expect(liveInputsKey(page([30129], 3))).not.toBe(liveInputsKey(page([30129], 4)));
	});

	it('uses the export form, which leaves out the item database', () => {
		expect(liveInputsKey(page([30129]))).not.toContain('database');
	});
});

describe('inputsSignature', () => {
	const settings: RunSettings = {
		iterations: 3000,
		excludedSources: ['Crafted', 'Black Temple'],
		guaranteedSetKeys: ['preset:3:P3'],
		guaranteedSetItemIds: [30129, 1],
		prune: false,
	};
	const signature = (overrides: Partial<RunSettings> = {}, liveKey = 'page') => inputsSignature({ liveKey, settings: { ...settings, ...overrides } });

	it('is equal for equal parts, whatever order the lists were built in', () => {
		expect(signature()).toBe(signature({ excludedSources: ['Black Temple', 'Crafted'], guaranteedSetItemIds: [1, 30129] }));
	});

	it('changes when the page changes', () => {
		expect(signature({}, 'other page')).not.toBe(signature());
	});

	it.each<[string, Partial<RunSettings>]>([
		['iterations', { iterations: 500 }],
		['cap', { candidateCap: 40 }],
		['an excluded source', { excludedSources: ['Crafted'] }],
		['a selected set', { guaranteedSetKeys: [] }],
		['prune', { prune: true }],
	])('changes when %s changes', (_name, overrides) => {
		expect(signature(overrides)).not.toBe(signature());
	});
});
