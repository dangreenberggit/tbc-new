/**
 * Store: a cache of blobs keyed by their content, plus job rows. `MemoryStore` keeps them
 * for the page session only.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export type Job = {
	id: string;
	contentHash: string;
	status: JobStatus;
	input: unknown;
	progress?: unknown;
	errorKind?: string;
	errorDetail?: string;
	result?: unknown;
	createdAt: string;
	updatedAt: string;
};

export type JobCreateInput = {
	contentHash: string;
	input: unknown;
};

export type JobUpdateInput = {
	status?: JobStatus;
	progress?: unknown;
	errorKind?: string;
	errorDetail?: string;
	result?: unknown;
};

export interface Store {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	job: {
		create(input: JobCreateInput): Promise<Job>;
		update(id: string, patch: JobUpdateInput): Promise<Job | undefined>;
		read(id: string): Promise<Job | undefined>;
	};
}

export class MemoryStore implements Store {
	private readonly blobs = new Map<string, unknown>();
	private readonly jobs = new Map<string, Job>();
	private seq = 0;

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async get<T>(key: string): Promise<T | undefined> {
		if (!this.blobs.has(key)) return undefined;
		return this.blobs.get(key) as T;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.blobs.set(key, value);
	}

	readonly job = {
		create: async (input: JobCreateInput): Promise<Job> => {
			this.seq += 1;
			const now = this.clock().toISOString();
			const job: Job = {
				id: `job_${this.seq}`,
				contentHash: input.contentHash,
				status: 'queued',
				input: input.input,
				createdAt: now,
				updatedAt: now,
			};
			this.jobs.set(job.id, job);
			return job;
		},

		update: async (id: string, patch: JobUpdateInput): Promise<Job | undefined> => {
			const existing = this.jobs.get(id);
			if (!existing) return undefined;
			const updated: Job = {
				...existing,
				...patch,
				updatedAt: this.clock().toISOString(),
			};
			this.jobs.set(id, updated);
			return updated;
		},

		read: async (id: string): Promise<Job | undefined> => {
			return this.jobs.get(id);
		},
	};
}
