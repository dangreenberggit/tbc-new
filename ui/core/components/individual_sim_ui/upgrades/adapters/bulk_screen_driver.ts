/**
 * The chunk loop both bulk runners drive.
 *
 * Shared rather than duplicated (superseding review row S3) because the two
 * transports must not differ on cancel or on failure handling: ticket 347's
 * whole complaint was that a fix applied to one runner would leave the other
 * behaving differently. With the loop here, each runner shrinks to a
 * constructor plus a one-line `dispatch`, so identical behaviour is a property
 * of the code shape rather than of two edits staying in step.
 *
 * ## How cancel works
 *
 * The caller's `AbortSignal` is the cancel source, and it outlives the chunk —
 * which the old structure could not manage. Each runner used to manufacture a
 * fresh `SimSignals` inside its loop body and then test it, so nothing could
 * ever have triggered it and the guard was unconditionally false (ticket 347's
 * Correction). Here the listener is registered once, outside the loop, and
 * triggers whichever chunk's signals are in flight. That trigger reaches the
 * engine for real: `worker_pool.ts` subscribes each request to `signals.abort`
 * and calls `sendAbortById`, the Go server's `/abortById` reaches
 * `simsignals.AbortById`, and the raid sim checks the flag every iteration.
 *
 * ## Why a boolean and not the signal
 *
 * `signals.abort.isTriggered()` cannot tell a user Stop from a candidate
 * failure, because upstream triggers the chunk's own signals on any candidate
 * error to stop the rest of that batch (`wasm/bulk_sim/batch.ts:132-134`).
 * Classifying on the signal would therefore turn one panicking candidate into
 * "the user pressed Stop" — every remaining chunk skipped and every candidate
 * returned unsimmed. So the driver keeps `userAborted`, written only by the
 * `AbortSignal` listener or by `signal.aborted` at entry, and classifies on
 * that alone.
 *
 * A single pass-level `SimSignals` was rejected for the same reason: upstream's
 * error-trigger on chunk k would have poisoned chunk k+1. Signals are
 * registered **per chunk**, so an error-trigger can only reach the chunk that
 * failed.
 */

import { BulkSimRequest, BulkSimResult } from '../../../../proto/api.js';
import { RequestTypes, SimSignalManager, SimSignals } from '../../../../sim_signal_manager.js';
import { MAX_CANDIDATES_PER_BULK_REQUEST, partitionForBulkScreen } from '../engine/bulk/partition.js';
import {
	BulkScreenAbortedError,
	BulkScreenIntegrityError,
	type BulkScreenRequest,
	type BulkScreenResult,
	type SimObservation,
} from '../engine/seams/sim-runner.js';
import { assertSingleStageChunk, buildBulkSimRequest } from './bulk_request_builder.js';
import { bulkScreenResultFrom } from './bulk_wasm_sim_runner.js';

/** A transport's own way of sending one built chunk. */
export type BulkChunkDispatch = (request: BulkSimRequest, signals: SimSignals) => Promise<BulkSimResult>;

export type BulkScreenDriverDeps = {
	signals: SimSignalManager;
	simVersion: string;
	dispatch: BulkChunkDispatch;
};

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runBulkScreenChunks(req: BulkScreenRequest, deps: BulkScreenDriverDeps): Promise<BulkScreenResult> {
	const chunks = partitionForBulkScreen(req.candidates, MAX_CANDIDATES_PER_BULK_REQUEST);
	let userAborted = req.signal?.aborted ?? false;
	let inFlight: SimSignals | undefined;
	// Not awaited: `trigger()` fans out a `sendAbortById` round trip per
	// subscribed request, and an `abort` listener is not the place to wait on
	// the network.
	const onAbort = () => {
		userAborted = true;
		void inFlight?.abort.trigger();
	};
	req.signal?.addEventListener('abort', onAbort, { once: true });

	const rows: { index: number; observation: SimObservation }[] = [];
	const failures: { indices: readonly number[]; reason: string }[] = [];
	let baseline: SimObservation | undefined;

	try {
		for (const chunk of chunks) {
			if (userAborted) break;
			const request = buildBulkSimRequest({ ...req, candidates: chunk });
			// Outside the inner try on purpose: a chunk that would be culled is a
			// programming error in the partition bound, not a transport failure, so
			// it must never degrade to the per-candidate loop.
			assertSingleStageChunk(request, chunk.length);
			const signals = deps.signals.registerRunning(RequestTypes.BulkSim);
			inFlight = signals;
			try {
				const mapped = bulkScreenResultFrom(await deps.dispatch(request, signals), chunk.length, deps.simVersion);
				// Each chunk re-probes its own baseline, so later chunks would
				// otherwise overwrite the first. Keeping the first makes every
				// screening delta in this batch share one reference point.
				baseline ??= mapped.baseline;
				rows.push(...mapped.rows);
			} catch (err) {
				// Classified first: during a user abort both engines report
				// `ErrorOutcomeAborted`, which arrives here as an ordinary throw.
				if (userAborted) throw new BulkScreenAbortedError();
				// A structurally wrong response is ticket 349's guard doing its job;
				// degrading it would hide exactly what it exists to catch.
				if (err instanceof BulkScreenIntegrityError) throw err;
				failures.push({ indices: chunk.map(candidate => candidate.index), reason: messageOf(err) });
			} finally {
				inFlight = undefined;
				deps.signals.unregisterRunning(signals);
			}
		}

		if (userAborted) throw new BulkScreenAbortedError();
		if (baseline === undefined) {
			throw new Error(`bulk screen: every chunk failed — ${failures.map(failure => failure.reason).join('; ')}`);
		}
		return { baseline, rows, ...(failures.length ? { failures } : {}) };
	} finally {
		req.signal?.removeEventListener('abort', onAbort);
	}
}
