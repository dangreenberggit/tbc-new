/**
 * Whether parsed JSON is a plain object. It imports nothing: the tab body that loads with every page
 * reaches it through `saved_entry.ts` and must not pull in the lazily loaded tab code (`lazy_load.test.ts`).
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
