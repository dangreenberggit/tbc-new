import { APLListItem, APLRotation, APLRotation_Type } from '@generated/proto/apl';
import { ActionID, Cooldowns, type Spec } from '@generated/proto/common';
import type { JsonValue } from '@protobuf-ts/runtime';
import { describe, expect, it } from 'vitest';

import ArcaneApl from '../../specs/mage/dps/apls/arcane.apl.json';
import type { Player } from '../player/player';
import { hideScheduledCooldownCasts, isEqualAPLRotation, renameAPLReference } from './apl_utils';

// Only the TypeSimple branch reaches the player, and none of these cases take it.
const player = null as unknown as Player<Spec>;

const rotation = (type: APLRotation_Type, spellId: number) =>
	APLRotation.create({
		type,
		priorityList: [
			{ action: { action: { oneofKind: 'castSpell', castSpell: { spellId: ActionID.create({ rawId: { oneofKind: 'spellId', spellId } }) } } } },
		],
	});

describe('isEqualAPLRotation', () => {
	it('matches an Auto rotation against the APL rotation it resolves to', () => {
		expect(isEqualAPLRotation(player, rotation(APLRotation_Type.TypeAuto, 100), rotation(APLRotation_Type.TypeAPL, 100))).toBe(true);
		expect(isEqualAPLRotation(player, rotation(APLRotation_Type.TypeAPL, 100), rotation(APLRotation_Type.TypeAuto, 100))).toBe(true);
	});

	it('still separates rotations that differ below the type', () => {
		expect(isEqualAPLRotation(player, rotation(APLRotation_Type.TypeAuto, 100), rotation(APLRotation_Type.TypeAPL, 200))).toBe(false);
	});

	it('leaves both arguments untouched', () => {
		const auto = rotation(APLRotation_Type.TypeAuto, 100);
		const apl = rotation(APLRotation_Type.TypeAPL, 100);
		isEqualAPLRotation(player, auto, apl);
		expect(auto.type).toBe(APLRotation_Type.TypeAuto);
		expect(apl.type).toBe(APLRotation_Type.TypeAPL);
	});

	it('treats a missing rotation as unequal to a present one', () => {
		expect(isEqualAPLRotation(player, undefined, rotation(APLRotation_Type.TypeAPL, 100))).toBe(false);
		expect(isEqualAPLRotation(player, undefined, undefined)).toBe(true);
	});

	// The Simple branch does reach the player, so it needs the two codec hooks it calls.
	const simplePlayer = {
		specTypeFunctions: { rotationFromJson: (json: unknown) => json, rotationEquals: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) },
	} as unknown as Player<Spec>;

	const simple = (cooldowns: Cooldowns) =>
		APLRotation.create({ type: APLRotation_Type.TypeSimple, simple: { specRotationJson: '{"spec":"Fury"}', cooldowns } });

	it('separates Simple rotations that differ only in cooldown timings', () => {
		const a = simple(Cooldowns.create({ cooldowns: [{ id: ActionID.create(), timings: [10] }] }));
		const b = simple(Cooldowns.create({ cooldowns: [{ id: ActionID.create(), timings: [20] }] }));

		expect(isEqualAPLRotation(simplePlayer, a, b)).toBe(false);
		expect(isEqualAPLRotation(simplePlayer, a, simple(Cooldowns.clone(a.simple!.cooldowns!)))).toBe(true);
	});
});

describe('renameAPLReference', () => {
	// `Action Group is used` stores the group as a bare `{name}`, which the generic walk cannot spot.
	it('renames a group inside an actionGroupUsed condition', () => {
		const rotation = APLRotation.create({
			priorityList: [{ action: { condition: { value: { oneofKind: 'actionGroupUsed', actionGroupUsed: { name: 'Cooldowns' } } } } }],
		});

		renameAPLReference(rotation, { type: 'group', oldName: 'Cooldowns', newName: 'Burst' });

		const value = rotation.priorityList[0].action!.condition!.value;
		expect(value.oneofKind === 'actionGroupUsed' && value.actionGroupUsed.name).toBe('Burst');
	});
});

describe('hideScheduledCooldownCasts', () => {
	const ICY_VEINS = 12472;
	const COLD_SNAP = 11958;
	const BERSERKING = 20554;
	const ARCANE_POWER = 12042;

	const arcane = () => APLRotation.fromJson(ArcaneApl as unknown as JsonValue);
	const allItems = (rotation: APLRotation) => [...rotation.priorityList, ...rotation.groups.flatMap(group => group.actions)];
	const castId = (item: APLListItem) => {
		const a = item.action?.action;
		return a?.oneofKind === 'castSpell' && a.castSpell.spellId?.rawId.oneofKind === 'spellId' ? a.castSpell.spellId.rawId.spellId : null;
	};
	const hiddenIds = (rotation: APLRotation) =>
		allItems(rotation)
			.filter(item => item.hide)
			.map(castId);
	const cd = (spellId: number, timings: Array<number>, tag = 0) => ({ id: ActionID.create({ rawId: { oneofKind: 'spellId', spellId }, tag }), timings });
	const castItem = (spellId: number) =>
		APLListItem.create({
			action: { action: { oneofKind: 'castSpell', castSpell: { spellId: ActionID.create({ rawId: { oneofKind: 'spellId', spellId } }) } } },
		});
	const hide = (cooldowns: Cooldowns) => {
		const rotation = arcane();
		hideScheduledCooldownCasts(rotation, cooldowns);
		return rotation;
	};

	it('leaves the preset untouched when no cooldown has timings', () => {
		expect(hide(Cooldowns.create())).toEqual(arcane());
		// A picked cooldown with no timings yields an invalid schedule, so the preset line must stay.
		expect(hide(Cooldowns.create({ cooldowns: [cd(ICY_VEINS, [])] }))).toEqual(arcane());
	});

	it('hides the preset Icy Veins cast once Icy Veins is scheduled, and nothing else', () => {
		const rotation = hide(Cooldowns.create({ cooldowns: [cd(ICY_VEINS, [10])] }));

		expect(hiddenIds(rotation)).toEqual([ICY_VEINS]);
		// Indices stay stable: nothing is removed.
		expect(rotation.priorityList).toHaveLength(arcane().priorityList.length);
		// Cold Snap only reads Icy Veins in its condition, so it stays to enable a second scheduled Icy Veins.
		expect(allItems(rotation).find(item => castId(item) === COLD_SNAP)?.hide).toBe(false);
	});

	it('hides matching casts inside action groups', () => {
		const rotation = APLRotation.create({
			groups: [{ name: 'Cooldowns', actions: [castItem(ICY_VEINS), castItem(COLD_SNAP)] }],
		});
		hideScheduledCooldownCasts(rotation, Cooldowns.create({ cooldowns: [cd(ICY_VEINS, [10])] }));

		expect(rotation.groups[0].actions.map(item => item.hide)).toEqual([true, false]);
	});

	it('hides top-level casts too, matching across tags', () => {
		expect(hiddenIds(hide(Cooldowns.create({ cooldowns: [cd(BERSERKING, [5], 0)] })))).toEqual([BERSERKING]);
	});

	it('is a no-op for a scheduled cooldown the preset never casts directly', () => {
		// Arcane Power is only autocast in the preset; its schedule action alone takes it out of autocast.
		expect(hide(Cooldowns.create({ cooldowns: [cd(ARCANE_POWER, [15])] }))).toEqual(arcane());
	});
});
