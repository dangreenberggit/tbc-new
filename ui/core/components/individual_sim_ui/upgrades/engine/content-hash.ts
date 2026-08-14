/**
 * canonicalJson — the cache-key string builder, ADAPTED per D4.
 *
 * packages/core/src/content-hash.ts hashes `canonicalJson`'s output with
 * `node:crypto`'s sha256 into `contentHashOf`. D4 rules that moot in the
 * fork: cache keys need uniqueness, not compression, and the browser has no
 * `node:crypto`. So this module keeps `canonicalJson` (the deterministic
 * sorted-key serializer — pinned by test rather than left to
 * `JSON.stringify`'s object-order behaviour, same as packages/core) and
 * drops `sha256Hex`/`contentHashOf` entirely; `rank.ts` calls
 * `canonicalJson(...)` directly where packages/core called `contentHashOf`,
 * and the result *is* the cache key rather than a hash of one.
 *
 * `HashedGearItem` and `ENGINE_VERSION` are ported unchanged — both are
 * plain data shapes/constants with nothing to adapt.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(
      `content hash inputs must be finite numbers, got ${value}`
    );
  }
  if (Array.isArray(value)) {
    return value.map((el) => (el === undefined ? null : canonicalize(el)));
  }
  if (value !== null && typeof value === "object") {
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

/**
 * Bump when a ranking-logic change should invalidate every cached result.
 * PORTED unchanged from packages/core/src/content-hash.ts.
 */
export const ENGINE_VERSION = 6;

export type HashedGearItem = {
  id: number;
  slot: string;
  enchant?: number;
  gems?: readonly number[];
};
