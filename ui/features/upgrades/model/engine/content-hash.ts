/**
 * canonicalJson: the sorted-key serializer that builds the ranking cache key, so key order
 * does not follow insertion order. The string is the key itself, not hashed: the cache
 * needs uniqueness, not compression.
 */

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new TypeError(`content hash inputs must be finite numbers, got ${value}`);
	}
	if (Array.isArray(value)) {
		return value.map(el => (el === undefined ? null : canonicalize(el)));
	}
	if (value !== null && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			if (obj[key] === undefined) continue;
			out[key] = canonicalize(obj[key]);
		}
		return out;
	}
	return value;
}

/** Bump when a ranking-logic change should invalidate every cached result. */
export const ENGINE_VERSION = 8;

export type HashedGearItem = {
	id: number;
	slot: string;
	enchant?: number;
	gems?: readonly number[];
};
