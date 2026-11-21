/**
 * `bonusGearSims` and `setBonusOffSims`: sims of the full gear a set piece's row would be
 * worn in, its partners chosen, and the same gear with the bonus off.
 */

import type { GemContext } from './candidate-gems';
import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { isRepairFailure, repairErrorOr, type RequestsPerCopyLayout } from './hit-budget';
import { getItem } from './items';
import { MetaRepairError } from './meta-repair';
import { choosePartners, PARTNER_RULE, type PartnerPiece, partnerPool } from './partner-choice';
import { promisePool } from './promise-pool';
import type { BonusGearSims, BrokenSetValue, Deps, RankedItem, SetBonusOffSims, SetBonusValue, SetContext } from './rank-types';
import { breakSplitSkipNote, SET_BONUS_SKIP_REASONS, setBonusSkipNote, type SkipReason } from './run-notes';
import { type RaidSimRequest, simCacheKey, type SimRunOpts, stableStringify } from './seams/sim-runner';
import { clearsSameGearNoise, errorText, isBuildFailure, isSimFailure, type SimFailure } from './set-less-copies';
import { bonusKey, brokenSetBonuses, type CountsAsBreak, type DpsSample, type OwnDelta, type PlacedItem, setNameOf, type SetThreshold } from './set-value';
import { cacheSimResult, readCachedSim } from './sim-calls';
import type { SimItemSpec } from './slots';
import { setCreditUnmeasured, setPotentialIncrements } from './view';

/**
 * With `measureSetBonuses`, values each set row's future bonuses by sim.
 * For each bonus above noise, `choosePartners` picks the other set pieces,
 * and the current gear plus the row plus those pieces (swapped in slot order,
 * with the usual gem repairs) is simmed once per distinct gear; its
 * `bonusGearDps` is that sim minus the baseline. A failed choice, repair or
 * sim leaves the row unmeasured and never fails the ranking. Then the
 * bonus-off sims run for the bonuses the popover shows.
 */
export async function measureBonusGear(args: {
	deps: Deps;
	ranked: RankedItem[];
	setBonuses: readonly SetBonusValue[];
	equipment: readonly SimItemSpec[];
	gems: GemContext;
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest;
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	brokenSetValues: readonly BrokenSetValue[];
	firstSlotIndexByItemId: ReadonlyMap<number, number>;
	countsAsBreak: CountsAsBreak;
	baseline: DpsSample;
	simVersion: string;
	runOpts: SimRunOpts;
	cutoff: Cutoff;
	/** Every request here comes from it. */
	requestsPerLayout: RequestsPerCopyLayout;
	/** A line, with the sim's error, for each bonus whose partner or bonus-off sim failed. */
	bonusNotes: RunNote[];
}): Promise<{
	bonusGearSims: BonusGearSims;
	bonusOffSims: SetBonusOffSims;
}> {
	const { deps, equipment, gems, composeFor, countsAsBreak, baseline, runOpts } = args;
	const brokenBonusDpsByKey = new Map<string, number | undefined>();
	for (const v of args.brokenSetValues) {
		brokenBonusDpsByKey.set(bonusKey(v), v.dps);
	}
	const nameOf = new Map(args.ranked.map(r => [r.itemId, r.name]));
	type SimCounter = { simmed: number; fromStore: number };
	const bonusGearCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const bonusGearFailure = '[upgrades] set bonus gear not measured: the sim failed';

	const runCounted = async (request: RaidSimRequest, counter: SimCounter, failure: string): Promise<{ deltaDps: number; se: number } | SimFailure> => {
		let obs = await readCachedSim(deps, request, args.simVersion, runOpts);
		if (obs) {
			counter.fromStore += 1;
		} else {
			try {
				obs = await deps.sim.run(request, runOpts);
			} catch (err) {
				// No warning for a sim the Stop guard refused.
				if (!deps.signal?.aborted) console.warn(failure, err);
				return { simError: errorText(err) };
			}
			counter.simmed += 1;
			await cacheSimResult(deps, request, args.simVersion, runOpts, obs);
		}
		const se = obs.stdev / Math.sqrt(runOpts.iterations);
		return {
			deltaDps: obs.dps - baseline.dps,
			se: Math.sqrt(se ** 2 + baseline.se ** 2),
		};
	};

	/** A bonus some rows could not measure, and why. */
	const skipOnSomeRows = (setName: string, threshold: SetThreshold, reason: SkipReason) =>
		args.bonusNotes.push(setBonusSkipNote({ setName, threshold, reason, onSomeRows: true }));

	const inSlotOrder = (swaps: readonly PlacedItem[]) => [...swaps].sort((a, b) => a.slotIndex - b.slotIndex);
	/** The row-and-partners gear, or the error of its failed gem repair. */
	const bonusGearChain = (swaps: readonly PlacedItem[]): ChainBuild | MetaRepairError => {
		try {
			return chainSwapsWithRepairs(equipment, inSlotOrder(swaps), gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			return err;
		}
	};
	/** The row-and-partners gear, or undefined when a gem repair fails. */
	const bonusGearBuild = (swaps: readonly PlacedItem[]): ChainBuild | undefined => {
		const chain = bonusGearChain(swaps);
		return chain instanceof MetaRepairError ? undefined : chain;
	};
	const bonusGearRebuild = (swaps: readonly PlacedItem[]) => (g: GemContext) => chainSwapsWithRepairs(equipment, inSlotOrder(swaps), g);

	/**
	 * With its own gem repair, or why it could not be built: a failed gem repair
	 * or a request build error.
	 */
	const bonusGearRequest = async (swaps: readonly PlacedItem[]): Promise<RaidSimRequest | SkipReason> => {
		const build = bonusGearChain(swaps);
		if (build instanceof MetaRepairError) {
			return SET_BONUS_SKIP_REASONS.metaOff(build.message);
		}
		const entry = (await args.requestsPerLayout(bonusGearRebuild(swaps), build, [{}]))[0]!;
		if (isRepairFailure(entry)) {
			return SET_BONUS_SKIP_REASONS.metaOff(entry.repairError.message);
		}
		return isBuildFailure(entry) ? SET_BONUS_SKIP_REASONS.rowsNotBuilt(entry.buildError) : entry.request;
	};
	const isSkipReason = (value: RaidSimRequest | SkipReason): value is SkipReason => 'because' in value;

	type FutureBonus = NonNullable<SetContext['futureBonuses']>[number];
	const requests = new Map<string, RaidSimRequest>();
	const pending: Array<{ future: FutureBonus; key: string; setName: string }> = [];
	const rowSwapOf = new Map<RankedItem, PlacedItem>();
	const partnersOf = new Map<FutureBonus, PlacedItem[]>();

	for (const item of args.ranked) {
		const ctx = item.setContext;
		if (!ctx) continue;
		const ownDelta = args.ownDeltasByItemId.get(item.itemId);
		if (!ownDelta) continue;
		ctx.singleDeltaDps = ownDelta.deltaDps;
		const eligible = (ctx.futureBonuses ?? []).filter(
			f => !f.belowNoise && f.sameGearDps !== undefined && clearsSameGearNoise(f.sameGearDps, f.sameGearSe ?? 0, args.cutoff),
		);
		if (eligible.length === 0) continue;

		const setId = ctx.setId;
		const wornSetSlots = new Set(equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : [])));
		const pieces: PartnerPiece[] = [];
		for (const [itemId, slotIndex] of args.firstSlotIndexByItemId) {
			if (itemId === item.itemId || getItem(itemId)?.setId !== setId) continue;
			const delta = args.ownDeltasByItemId.get(itemId);
			if (!delta) continue;
			pieces.push({ itemId, slotIndex, ownDeltaDps: delta.deltaDps });
		}
		const pool = partnerPool({
			pieces,
			wornSetSlots,
			rowSlotIndex: ownDelta.slotIndex,
		});
		const rowSwap: PlacedItem = {
			itemId: item.itemId,
			slotIndex: ownDelta.slotIndex,
		};
		rowSwapOf.set(item, rowSwap);
		const brokenBy = (swaps: readonly PlacedItem[]) => brokenSetBonuses(equipment, swaps, setId, countsAsBreak);

		for (const f of eligible) {
			// A partner combination whose sim fails is skipped, and the chosen
			// combination's gear is simmed below, so a failure counts for the row
			// only when no combination is chosen.
			let partnerSimFailure: SkipReason | undefined;
			const choice = await choosePartners({
				row: {
					itemId: item.itemId,
					slotIndex: ownDelta.slotIndex,
					ownDeltaDps: ownDelta.deltaDps,
				},
				setId,
				threshold: f.threshold,
				needed: f.threshold - ctx.piecesAfterSwap,
				pool,
				brokenBy,
				breakDps: (s, c) => brokenBonusDpsByKey.get(`${s}:${c}`),
				simGear: async partners => {
					const request = await bonusGearRequest([rowSwap, ...partners]);
					if (isSkipReason(request)) {
						partnerSimFailure ??= request;
						return undefined;
					}
					const delta = await runCounted(request, bonusGearCounter, bonusGearFailure);
					if (!isSimFailure(delta)) return delta;
					partnerSimFailure ??= SET_BONUS_SKIP_REASONS.rowSimsFailed(delta.simError);
					return undefined;
				},
			});
			// Here a future bonus's `pieces` and `breaks` come from the partner
			// choice, so the `pathToThreshold` ones are dropped first.
			delete f.pieces;
			delete f.breaks;
			if (choice === undefined) {
				if (partnerSimFailure !== undefined) {
					skipOnSomeRows(ctx.setName, f.threshold, partnerSimFailure);
				}
				continue;
			}
			if ('unmeasured' in choice) {
				f.partnerUnmeasured = choice.unmeasured;
				continue;
			}
			const slotOf = new Map<number, number>();
			for (const p of pool) {
				slotOf.set(p.itemId, p.slotIndex);
			}
			const partners: PlacedItem[] = choice.itemIds.map(itemId => ({ itemId, slotIndex: slotOf.get(itemId)! })).sort((a, b) => a.slotIndex - b.slotIndex);
			partnersOf.set(f, partners);
			f.partnerRule = PARTNER_RULE;
			f.pieces = partners.map(p => ({
				itemId: p.itemId,
				name: nameOf.get(p.itemId) ?? String(p.itemId),
			}));
			// Every counted worn bonus this gear loses against the current gear,
			// the row's own loss included, because the popover line is a total
			// against the current gear.
			const broken = brokenBy([rowSwap, ...partners]);
			if (broken.length > 0) {
				f.breaks = broken.map(brk => {
					const dps = brokenBonusDpsByKey.get(bonusKey(brk));
					return {
						setId: brk.setId,
						setName: brk.setName,
						threshold: brk.threshold,
						...(dps !== undefined ? { dps } : {}),
					};
				});
			}
			const request = await bonusGearRequest([rowSwap, ...partners]);
			if (isSkipReason(request)) {
				skipOnSomeRows(ctx.setName, f.threshold, request);
				continue;
			}
			const key = simCacheKey(request, args.simVersion, runOpts);
			requests.set(key, request);
			pending.push({ future: f, key, setName: ctx.setName });
		}
	}

	// Identical gears are simmed once. Each task handles its own sim failure,
	// so one failed sim leaves only its own future bonuses unmeasured.
	const deltas = new Map<string, { deltaDps: number; se: number }>();
	const bonusGearErrors = new Map<string, string>();
	const keys = [...requests.keys()];
	await promisePool(
		keys.map(key => async () => {
			const delta = await runCounted(requests.get(key)!, bonusGearCounter, bonusGearFailure);
			if (isSimFailure(delta)) bonusGearErrors.set(key, delta.simError);
			else deltas.set(key, delta);
		}),
		deps.concurrency ?? 1,
	);
	for (const { future, key, setName } of pending) {
		const simError = bonusGearErrors.get(key);
		if (simError !== undefined) {
			skipOnSomeRows(setName, future.threshold, SET_BONUS_SKIP_REASONS.rowSimsFailed(simError));
		}
		const delta = deltas.get(key);
		if (!delta) continue;
		future.bonusGearDps = delta.deltaDps;
		future.bonusGearSe = delta.se;
	}

	// The bonus-off sims run for exactly the bonuses the popover shows, so this
	// uses the view's own list of them (`setPotentialIncrements`).
	const offCounter: SimCounter = { simmed: 0, fromStore: 0 };
	const offRequests = new Map<string, { request: RaidSimRequest; plain: RaidSimRequest }>();
	const offPending: Array<{
		future: FutureBonus;
		key: string;
		broken: Array<{ setId: number; threshold: SetThreshold }>;
	}> = [];
	let skippedIncrements = 0;
	const setIdAt = (gear: readonly SimItemSpec[], slot: number): number | undefined => {
		const id = gear[slot]?.id;
		return (id ? getItem(id)?.setId : undefined) ?? undefined;
	};
	const countOf = (gear: readonly SimItemSpec[], setId: number) => gear.filter((_, slot) => setIdAt(gear, slot) === setId).length;

	/** Queues one shown bonus's bonus-off request; false when none can be built. */
	const queueBonusOff = async (
		future: FutureBonus,
		prevSwaps: readonly PlacedItem[],
		swaps: readonly PlacedItem[],
		broken: Array<{ setId: number; threshold: SetThreshold }>,
		firstIncrement: boolean,
	): Promise<boolean> => {
		const beforeBuild = bonusGearBuild(prevSwaps);
		const before = beforeBuild?.equipment;
		const after = bonusGearBuild(swaps)?.equipment;
		if (!beforeBuild || !before || !after) return false;
		const brokenSets = new Set(broken.map(b => b.setId));
		const prevIds = new Set(prevSwaps.map(p => p.itemId));
		const replaced = [...new Set(swaps.filter(p => !prevIds.has(p.itemId)).map(p => p.slotIndex))]
			.filter(slot => {
				const setId = setIdAt(before, slot);
				return setId !== undefined && brokenSets.has(setId);
			})
			.sort((a, b) => a - b);
		if (replaced.length === 0) return false;
		// Copying the replaced pieces must leave each lost set at its count after
		// this bonus's swaps; otherwise (a two-hander's off-hand, a repair) the
		// bonus-off gear is not the gear before minus exactly these bonuses.
		for (const setId of brokenSets) {
			const copied = replaced.filter(slot => setIdAt(before, slot) === setId).length;
			if (countOf(before, setId) - copied !== countOf(after, setId)) {
				return false;
			}
		}
		// `plain` must be the request simmed for the gear before and the bonus-off
		// request its pair, so both come from one call. For later bonuses entry 0
		// is the previous bonus's own request (the gear build is deterministic and
		// its read is cached).
		const beforeAndOffEntries = repairErrorOr(await args.requestsPerLayout(bonusGearRebuild(prevSwaps), beforeBuild, [{}, { setLess: replaced }]));
		// As when the gear before or after fails its repair above: the split is
		// skipped, with no line, since no call failed.
		if (beforeAndOffEntries instanceof MetaRepairError) {
			console.warn(
				'[upgrades] increment not split into breaks and pieces: the gem repair of the gear before or the bonus-off gear failed',
				beforeAndOffEntries,
			);
			return false;
		}
		const [plainEntry, offEntry] = beforeAndOffEntries;
		if (!plainEntry || !offEntry || isBuildFailure(plainEntry) || isBuildFailure(offEntry)) {
			const error = [plainEntry, offEntry].find(isBuildFailure)?.buildError;
			console.warn('[upgrades] increment not split into breaks and pieces: its request could not be built', error);
			if (error !== undefined) {
				for (const b of broken) {
					args.bonusNotes.push(
						breakSplitSkipNote({
							setName: setNameOf(equipment, b.setId),
							threshold: b.threshold,
							error,
							notBuilt: true,
						}),
					);
				}
			}
			return false;
		}
		const plain = plainEntry.request;
		const request = offEntry.request;
		// For the first bonus the gear before is the row's own swap, built here on
		// the run's hit budget. If entry 0 was repaired again for set-bonus hit
		// that budget misses, it differs from that build, so the split is skipped
		// rather than paired with gear gemmed another way. The candidate loop repairs
		// on the row's own stats read, so it may have simmed entry 0; this check
		// does not look for that sim.
		if (firstIncrement && stableStringify(plain) !== stableStringify(composeFor(before))) {
			return false;
		}
		const key = simCacheKey(request, args.simVersion, runOpts);
		if (!offRequests.has(key)) offRequests.set(key, { request, plain });
		offPending.push({ future, key, broken });
		return true;
	};

	for (const item of args.ranked) {
		const ctx = item.setContext;
		const rowSwap = rowSwapOf.get(item);
		if (!ctx?.usesBonusGear || !rowSwap || setCreditUnmeasured(ctx)) continue;
		const increments = setPotentialIncrements(ctx, args.cutoff);
		if (!increments) continue;
		let prevSwaps: PlacedItem[] | undefined = [rowSwap];
		let firstIncrement = true;
		for (const increment of increments) {
			const f = (ctx.futureBonuses ?? []).find(x => x.threshold === increment.threshold);
			const partners = f ? partnersOf.get(f) : undefined;
			const swaps = partners ? [rowSwap, ...partners] : undefined;
			if (increment.broken.length > 0) {
				const broken = increment.broken.map(b => ({
					setId: b.setId,
					threshold: b.threshold as SetThreshold,
				}));
				const queued =
					f !== undefined && swaps !== undefined && prevSwaps !== undefined && (await queueBonusOff(f, prevSwaps, swaps, broken, firstIncrement));
				if (!queued) skippedIncrements += 1;
			}
			prevSwaps = swaps;
			firstIncrement = false;
		}
	}

	// The popover's loss line is the bonus-off sim minus the sim of the gear
	// before without copies (the previous bonus's gear, or the row's own swap).
	// Only a gear-before sim this run already holds makes that a paired
	// difference, so a request whose gear-before sim is missing is not simmed.
	const paired = new Set<string>();
	for (const [key, { plain }] of offRequests) {
		if (await readCachedSim(deps, plain, args.simVersion, runOpts)) {
			paired.add(key);
		}
	}
	const offDeltas = new Map<string, { deltaDps: number; se: number }>();
	const offErrors = new Map<string, string>();
	let failedGears = 0;
	await promisePool(
		[...paired].map(key => async () => {
			const delta = await runCounted(offRequests.get(key)!.request, offCounter, '[upgrades] increment not split into breaks and pieces: the sim failed');
			if (isSimFailure(delta)) {
				offErrors.set(key, delta.simError);
				failedGears += 1;
			} else offDeltas.set(key, delta);
		}),
		deps.concurrency ?? 1,
	);
	for (const { future, key, broken } of offPending) {
		if (!paired.has(key)) {
			skippedIncrements += 1;
			continue;
		}
		const simError = offErrors.get(key);
		if (simError !== undefined) {
			for (const b of broken) {
				args.bonusNotes.push(
					breakSplitSkipNote({
						setName: setNameOf(equipment, b.setId),
						threshold: b.threshold,
						error: simError,
					}),
				);
			}
		}
		const delta = offDeltas.get(key);
		if (!delta) continue;
		future.bonusOffDps = delta.deltaDps;
		future.bonusOffSe = delta.se;
		future.bonusOff = broken;
	}

	return {
		bonusGearSims: {
			partnerRule: PARTNER_RULE,
			gears: keys.length,
			simmed: bonusGearCounter.simmed,
			fromStore: bonusGearCounter.fromStore,
		},
		bonusOffSims: {
			gears: offRequests.size,
			simmed: offCounter.simmed,
			fromStore: offCounter.fromStore,
			failedGears,
			skippedIncrements,
			beforeInStore: paired.size,
		},
	};
}
