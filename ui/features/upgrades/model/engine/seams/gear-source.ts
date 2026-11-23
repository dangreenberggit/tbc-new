/** GearSource: reads gear through `findFights` / `readGear`, whatever the transport. */

import type { CharacterRef, FightRef, SpecId } from '../types';

export type FightSummary = {
	reportCode: string;
	fightId: number;
	encounterName: string;
	killedAt?: string;
	/** How the fight was found: WCL rankings ('ranked') or a report's own events ('report-events'). */
	route: 'ranked' | 'report-events';
	/** How sure the spec guess is, 0 to 1. */
	confidence: number;
	salvationUptime?: number;
};

export type LoggedItem = {
	id: number;
	slot: string;
	randomSuffix?: number;
	enchant?: number;
	gems?: number[];
};

/** Gear as a combat log or the page reports it. */
export type LoggedGear = {
	items: LoggedItem[];
	talentPointsByTree: [number, number, number];
	className?: string;
	specIdHint?: number;
	provenance: {
		reportCode: string;
		fightId: number;
		sourceID: number;
	};
};

export interface GearSource {
	findFights(c: CharacterRef, spec: SpecId): Promise<FightSummary[]>;
	readGear(f: FightRef): Promise<LoggedGear>;
}

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
