/**
 * Store: values keyed by the inputs that made them (a ranking, a sim result, a gear read).
 * `MemoryStore` keeps them for the page session only.
 */

export interface Store {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
}

export class MemoryStore implements Store {
	private readonly blobs = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		if (!this.blobs.has(key)) return undefined;
		return this.blobs.get(key) as T;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.blobs.set(key, value);
	}
}
