/** Kael'thas Sunstrider's temporary legendaries, which exist only in that fight. */
export const KAEL_TEMP_LEGENDARY_IDS = [30318, 30313, 30316, 30317, 30312, 30311, 30314] as const;

const kaelTempLegendaryIds = new Set<number>(KAEL_TEMP_LEGENDARY_IDS);

export function isKaelTempLegendary(itemId: number): boolean {
	return kaelTempLegendaryIds.has(itemId);
}
