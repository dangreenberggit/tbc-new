/**
 * Whether parsed JSON is a plain object, before its fields are read. It imports nothing, because the eager tab body
 * reaches it through `saved_entry.ts` and must not pull in the tab's code (`lazy_load.test.ts`).
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
