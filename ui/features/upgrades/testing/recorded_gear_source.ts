/** A `GearSource` that replays recorded fights and gear, for tests. */

import type { FightSummary, GearSource, LoggedGear } from '../model/engine/seams/gear-source';
import type { CharacterRef, FightRef, SpecId } from '../model/engine/types';

export type RecordedGearSourceData = {
	fights: ReadonlyMap<string, FightSummary[]>;
	gear: ReadonlyMap<string, LoggedGear>;
};

export function characterFightKey(c: CharacterRef, spec: SpecId): string {
	return `${c.region}|${c.realm.toLowerCase()}|${c.name.toLowerCase()}|${spec}`;
}

export function fightGearKey(f: FightRef): string {
	return `${f.reportCode}|${f.fightId}`;
}

export class RecordedGearSource implements GearSource {
	constructor(private readonly data: RecordedGearSourceData) {}

	async findFights(c: CharacterRef, spec: SpecId): Promise<FightSummary[]> {
		return this.data.fights.get(characterFightKey(c, spec)) ?? [];
	}

	async readGear(f: FightRef): Promise<LoggedGear> {
		const hit = this.data.gear.get(fightGearKey(f));
		if (!hit) {
			throw new Error(`no recording for fight ${fightGearKey(f)}`);
		}
		return hit;
	}
}
