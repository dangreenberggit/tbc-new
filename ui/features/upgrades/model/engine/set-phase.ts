/**
 * The set phase of a run: after the candidate sims, it measures what each set bonus is worth
 * and fills the `Ranking`'s set fields.
 */

import type { GemContext } from './candidate-gems';
import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { type CopyLayout, isRepairFailure, type LayoutRequest, repairErrorOr, requestOf, type RequestsPerCopyLayout } from './hit-budget';
import { getItem } from './items';
import { MetaRepairError } from './meta-repair';
import { estimateCombinedDelta, type PartnerPiece } from './partner-choice';
import { type PoolEntry, simSlotsForPoolSlot } from './pool';
import type { BrokenSetValue, CrossingCheck, Deps, RankInput, SetBonusValue, WornSetCountEntry } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusCountsSkipNote, setBonusSkipNote, setScreenSkipNote, type SkipReason } from './run-notes';
import type { RaidSimRequest, SimRunOpts } from './seams/sim-runner';
import { countMembersBreaking } from './set-bonus-net';
import { measurePairTwoPiece } from './set-bonus-values';
import { type BuildFailure, clearsSameGearNoise, errorText, isBuildFailure, isSimFailure, measureSameGearBonus } from './set-less-copies';
import { setBonusCountsInReach } from './set-reach';
import { runSetScreenOn, type SetScreen, type SetScreenInput } from './set-screen';
import {
	bonusKey,
	type BrokenSetBonus,
	brokenSetBonuses,
	computeBonusDps,
	type CountsAsBreak,
	type DpsSample,
	type InflationTerm,
	isBonusImplemented,
	netInflation,
	type OwnDelta,
	type PlacedItem,
	sampleOf,
	selectAddedPieces,
	type SelfSetConfound,
	SET_THRESHOLDS,
	setCounts,
	setNameOf,
	setPieceSlots,
	type SetThreshold,
} from './set-value';
import { brokenBonusDpsByKey, countsAsBreakFrom, measureWornSets } from './set-worn-ladder';
import { runSimAt, simOrFailure } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';
import type { Race } from './types';

export async function buildSetBonuses(
	deps: Deps,
	candidates: readonly PoolEntry[],
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	race: Race,
	input: RankInput,
	/**
	 * `rankUpgrades`'s own compose helper, passed in rather than rebuilt here
	 * so the two cannot drift. Every composed request must carry the database
	 * its own equipment needs.
	 */
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
	baseline: DpsSample,
	simVersion: string,
	runOpts: SimRunOpts,
	setBonusNotes: RunNote[],
	setCheckNotes: RunNote[],
	/**
	 * When set, measure every worn set's bonuses on the player's gear, charge
	 * only the counted ones as losses, and check each reachable bonus against
	 * noise.
	 */
	measureSetBonuses: boolean,
	/** The ranking's cutoff, for the same-gear check on measured bonuses. */
	cutoff: Cutoff,
	/**
	 * The baseline sim's per-iteration stdev (`Ranking.baseline.stdev`), for
	 * the "on" screen's noise estimate.
	 */
	baselineStdev: number,
	/** Every set-phase request with repaired gems comes from it. */
	requestsPerLayout: RequestsPerCopyLayout,
): Promise<{
	bonuses: SetBonusValue[];
	brokenSetValues: BrokenSetValue[];
	/** `brokenSetValues`' DPS by `bonusKey`, for every reader of a lost bonus's value. */
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>;
	/** The worn sets' DPS at each piece count. Stored name: "ladder" is the list of counts. */
	wornSetLadder: WornSetCountEntry[];
	crossingChecks: CrossingCheck[];
	/**
	 * The first SIM_ORDER slot each item fits; nothing is compared. For
	 * `applySetContext` to find each row's losses.
	 */
	firstSlotIndexByItemId: Map<number, number>;
	/**
	 * No bonus in reach, or the set screen dropped them. Their rows still get
	 * a `setContext`.
	 */
	setIdsNotValued: number[];
	setScreen?: SetScreen;
}> {
	const bonusNotMeasured = (setName: string, threshold: SetThreshold, reason: SkipReason) =>
		setBonusNotes.push(setBonusSkipNote({ setName, threshold, reason }));

	// The set sims' store-cached run; the caller decides what a failed sim
	// costs.
	const cachedSampleRun =
		(what: string) =>
		async (request: RaidSimRequest): Promise<DpsSample> => {
			const outcome = await simOrFailure(deps, request, simVersion, runOpts);
			if ('simError' in outcome) {
				// After Stop the guard refused the sim, which is no sim failure,
				// and the caller drops this run's set figures.
				if (!deps.signal?.aborted) {
					console.warn(`[upgrades] ${what} not measured: the sim failed`, outcome.simError);
				}
				throw outcome.simError;
			}
			return sampleOf(outcome.observation, runOpts.iterations);
		};

	// The value of every bonus each worn set has, on the player's own gear,
	// before any reachable bonus is simmed, so every loss below reads a
	// measured value instead of a table. It runs even when no set piece is a
	// candidate, because `classifyDeadSlots` (in `plausibilityWarnings`) reads
	// it too.
	const wornSetLadder = measureSetBonuses
		? await measureWornSets(
				equipment,
				composeFor,
				cachedSampleRun,
				cutoff,
				setCheckNotes,
				deps.sim.activeSetBonuses ? request => deps.sim.activeSetBonuses!(request) : undefined,
			)
		: [];
	const countsAsBreak: CountsAsBreak = measureSetBonuses ? countsAsBreakFrom(wornSetLadder) : isBonusImplemented;
	const brokenSetValues: BrokenSetValue[] = wornSetLadder
		.filter(e => e.counted)
		.sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.count - a.count))
		.map(e => ({
			setId: e.setId,
			setName: e.setName,
			threshold: e.count,
			...(e.dps !== undefined ? { dps: e.dps } : {}),
			...(e.se !== undefined ? { se: e.se } : {}),
			...(e.unmeasured ? { unmeasured: e.unmeasured } : {}),
		}));
	const brokenDpsByKey = brokenBonusDpsByKey(brokenSetValues);

	const setIdsWithCandidates = new Set<number>();
	for (const entry of candidates) {
		const setId = getItem(entry.itemId)?.setId;
		if (setId != null) setIdsWithCandidates.add(setId);
	}

	const wornCounts = setCounts(equipment);
	const slotIndexForPoolEntry = (entry: PoolEntry): number | undefined => {
		for (const slotName of simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId)) {
			const idx = SIM_ORDER.indexOf(slotName);
			if (idx >= 0) return idx;
		}
		return undefined;
	};

	const selectFor = (setId: number, threshold: SetThreshold) =>
		selectAddedPieces(setId, threshold, equipment, candidates, [...ownDeltasByItemId.values()], slotIndexForPoolEntry);
	// Every count from one above the worn count up to the most pieces the pool
	// can fill, each with the pieces added to reach it.
	const addedByCount = (setId: number, piecesWorn: number) => {
		const out: Array<{ count: SetThreshold; pieces: PlacedItem[] }> = [];
		for (let t = Math.max(2, piecesWorn + 1); ; t++) {
			const selection = selectFor(setId, t);
			if (!selection.ok) break;
			out.push({ count: t, pieces: selection.addedPieces });
		}
		return out;
	};
	// With `measureSetBonuses`: the counts at which each set has a bonus,
	// as the sim lists them, so no count without a bonus is simmed
	// (Thunderheart Harness at 5).
	const bonusCounts = measureSetBonuses
		? await setBonusCountsInReach(
				deps.sim,
				setIdsWithCandidates,
				setId => {
					const byCount = addedByCount(setId, wornCounts.get(setId) ?? 0);
					return byCount[byCount.length - 1]?.pieces;
				},
				equipment,
				gems,
				composeFor,
				(setId, reason) =>
					setCheckNotes.push(
						setBonusCountsSkipNote({
							setName: setNameOf(
								equipment,
								setId,
								candidates.map(entry => entry.itemId),
							),
							reason,
						}),
					),
			)
		: new Map<number, ReadonlySet<number>>();
	// With `measureSetBonuses`: the counts in reach at which the set has a
	// bonus. The same-gear check below decides which are worth something here.
	const reachableCounts = (setId: number, piecesWorn: number): SetThreshold[] => {
		const known = bonusCounts.get(setId);
		return addedByCount(setId, piecesWorn)
			.map(entry => entry.count)
			.filter(t => !known || known.has(t));
	};

	// The screen runs after the worn-set values and before the loop over
	// reachable bonuses.
	const screenInput: SetScreenInput | undefined =
		measureSetBonuses && deps.setScreenMode === 'on'
			? {
					sets: [...setIdsWithCandidates]
						.sort((a, b) => a - b)
						.map(setId => {
							const worn = wornCounts.get(setId) ?? 0;
							const reachable = reachableCounts(setId, worn);
							return {
								setId,
								worn,
								reach: reachable[reachable.length - 1] ?? worn,
							};
						}),
					gearAt: (setId, threshold) => {
						const selection = selectFor(setId, threshold);
						if (!selection.ok) return undefined;
						// The same swaps as the loop below, so the screen sims the gear
						// that loop would build for this count.
						const pieces = selection.addedPieces;
						let base: ChainBuild;
						try {
							base = chainSwapsWithRepairs(equipment, pieces, gems);
						} catch (err) {
							if (!(err instanceof MetaRepairError)) throw err;
							return undefined;
						}
						return {
							request: composeFor(base.equipment),
							added: pieces,
							// Each copy layout gets its own gem repair; one whose repair
							// fails is not measured, as in the loop below.
							requestsFor: async copiesList =>
								(await requestsPerLayout(g => chainSwapsWithRepairs(equipment, pieces, g), base, copiesList)).map(entry =>
									isRepairFailure(entry) ? undefined : requestOf(entry),
								),
						};
					},
					runSimAt: (request, opts) => runSimAt(deps, request, simVersion, opts),
					seed: runOpts.seed,
					...(deps.signal ? { signal: deps.signal } : {}),
					onSimFailed: (setId, error) =>
						setCheckNotes.push(
							setScreenSkipNote({
								setName: setNameOf(
									equipment,
									setId,
									candidates.map(entry => entry.itemId),
								),
								error,
							}),
						),
					onRequestNotBuilt: (setId, error) =>
						setCheckNotes.push(
							setScreenSkipNote({
								setName: setNameOf(
									equipment,
									setId,
									candidates.map(entry => entry.itemId),
								),
								error,
								notBuilt: true,
							}),
						),
				}
			: undefined;
	// With `measureSetBonuses`: whether one more piece of a worn set reaches
	// a bonus, measured on the gear a row makes. One check per worn set with a
	// candidate in a slot the set does not fill, on that set's best such
	// candidate's own swap, so `crossesThreshold` reads a measurement rather
	// than the fixed table in `isBonusImplemented`.
	const crossingChecks: CrossingCheck[] = [];
	if (measureSetBonuses) {
		for (const setId of [...setIdsWithCandidates].sort((a, b) => a - b)) {
			const worn = wornCounts.get(setId) ?? 0;
			if (worn < 1) continue;
			// One more piece reaches no bonus the sim lists.
			if (bonusCounts.get(setId)?.has(worn + 1) === false) continue;
			const wornSlots = new Set(setPieceSlots(equipment, setId));
			let best: OwnDelta | undefined;
			for (const entry of candidates) {
				if (getItem(entry.itemId)?.setId !== setId) continue;
				const ownDelta = ownDeltasByItemId.get(entry.itemId);
				if (!ownDelta || wornSlots.has(ownDelta.slotIndex)) continue;
				if (!best || ownDelta.deltaDps > best.deltaDps || (ownDelta.deltaDps === best.deltaDps && ownDelta.itemId < best.itemId)) {
					best = ownDelta;
				}
			}
			if (!best) continue;
			const crossing = [{ slotIndex: best.slotIndex, itemId: best.itemId }];
			let swapped: ChainBuild | undefined;
			try {
				swapped = chainSwapsWithRepairs(equipment, crossing, gems);
			} catch (err) {
				if (!(err instanceof MetaRepairError)) throw err;
			}
			const crossingBuild = swapped;
			const crossingLabel = setNameOf(equipment, setId);
			// A copy's failed gem repair leaves this check unmeasured with no line,
			// as a failed repair of the swap itself does above.
			let layoutRepairFailed = false;
			const nextPieceResult = crossingBuild
				? await measureSameGearBonus(
						cachedSampleRun(`${crossingLabel} ${worn + 1}pc crossing check`),
						composeFor(crossingBuild.equipment),
						setPieceSlots(crossingBuild.equipment, setId),
						worn,
						// "On" and "off" are compared as a pair, so they come from
						// one call.
						async copiesList => {
							const entries = repairErrorOr(
								await requestsPerLayout(g => chainSwapsWithRepairs(equipment, crossing, g), crossingBuild, copiesList),
							);
							if (!(entries instanceof MetaRepairError)) {
								return entries.map(requestOf);
							}
							layoutRepairFailed = true;
							// Never read: the check's result is dropped below.
							return copiesList.map(() => ({ buildError: errorText(entries) }));
						},
					)
				: undefined;
			const measured = layoutRepairFailed ? undefined : nextPieceResult;
			if (isSimFailure(measured)) {
				bonusNotMeasured(crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.simFailed(measured.simError));
			}
			if (isBuildFailure(measured)) {
				bonusNotMeasured(crossingLabel, worn + 1, SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError));
			}
			const value = isSimFailure(measured) || isBuildFailure(measured) ? undefined : measured;
			crossingChecks.push({
				setId,
				count: worn + 1,
				itemId: best.itemId,
				...(value ? { dps: value.dps, se: value.se } : {}),
				cleared: value !== undefined && clearsSameGearNoise(value.dps, value.se, cutoff),
			});
		}
	}

	// The "on" screen estimates the added pieces' gain at each count with
	// `estimateCombinedDelta`, which adds no term for the set's own bonuses.
	// The estimate treats the row like any other added piece, so which piece is
	// the row does not matter. But each own delta of a set worn at w was simmed
	// with w + 1 pieces, so when w + 1 is a bonus count every own delta holds
	// that bonus once. The pair counts it already, so the crossing check's
	// value, which is that bonus, is taken out once per added piece (ticket
	// 886). A crossing check that ran without a value leaves the estimate
	// unset, and the screen keeps the set.
	const estimatedDeltaAt = (setId: number, threshold: number): number | undefined => {
		const selection = selectFor(setId, threshold);
		if (!selection.ok) return undefined;
		const crossing = crossingChecks.find(c => c.setId === setId && c.count === selection.piecesWorn + 1);
		if (crossing && crossing.dps === undefined) return undefined;
		const crossedPerPiece = crossing?.dps ?? 0;
		const pieces: PartnerPiece[] = [];
		for (const piece of selection.addedPieces) {
			const ownDelta = ownDeltasByItemId.get(piece.itemId)?.deltaDps;
			if (ownDelta === undefined) return undefined;
			pieces.push({
				itemId: piece.itemId,
				slotIndex: piece.slotIndex,
				ownDeltaDps: ownDelta,
			});
		}
		const [row, ...rest] = pieces;
		if (!row) return undefined;
		const estimate = estimateCombinedDelta(
			{
				row,
				brokenBy: swaps => brokenSetBonuses(equipment, swaps, setId, countsAsBreak),
				breakDps: (s, c) => brokenDpsByKey.get(`${s}:${c}`),
			},
			rest,
		);
		return estimate === undefined ? undefined : estimate - pieces.length * crossedPerPiece;
	};
	const setScreen: SetScreen | undefined = screenInput ? await runSetScreenOn({ ...screenInput, estimatedDeltaAt, baselineStdev }) : undefined;
	const screenedOut = new Set(setScreen ? setScreen.sets.filter(s => !s.kept).map(s => s.setId) : []);

	if (setIdsWithCandidates.size === 0) {
		return {
			bonuses: [],
			brokenSetValues,
			brokenBonusDpsByKey: brokenDpsByKey,
			wornSetLadder,
			crossingChecks: [],
			firstSlotIndexByItemId: new Map(),
			setIdsNotValued: [],
			...(setScreen ? { setScreen } : {}),
		};
	}

	const results: SetBonusValue[] = [];
	const setIdsNotValued: number[] = [];
	for (const setId of setIdsWithCandidates) {
		const piecesWorn = wornCounts.get(setId) ?? 0;
		const label = setNameOf(
			equipment,
			setId,
			candidates.map(entry => entry.itemId),
		);
		let twoPcBonusDps: number | undefined;
		let twoPieceUnmeasurableAtThisWornCount = false;
		// With `measureSetBonuses`: a 4pc's value subtracts the 2pc's, so it
		// stays unset when the 2pc's sims were tried and failed.
		let twoPieceFailed = false;

		const thresholds = measureSetBonuses ? reachableCounts(setId, piecesWorn) : SET_THRESHOLDS.filter(t => t > piecesWorn);
		// No bonus in reach, or the set screen dropped the set: no bonus sims at
		// all. The set goes in `setIdsNotValued`, so its rows keep their own losses
		// and `crossesThreshold` in `setContext`, but it gets no `setBonuses`
		// entry, since none of its counts is a bonus the ranking measured.
		if ((measureSetBonuses && thresholds.length === 0) || screenedOut.has(setId)) {
			setIdsNotValued.push(setId);
			continue;
		}

		for (const threshold of thresholds) {
			if (!measureSetBonuses && !isBonusImplemented(setId, threshold)) {
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: [],
					packageDeltaDps: 0,
					unmeasured: 'not-implemented-in-sim',
				});
				continue;
			}

			const selection = selectFor(setId, threshold);
			if (!selection.ok) {
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: [],
					packageDeltaDps: 0,
					unmeasured: 'insufficient-pieces',
				});
				continue;
			}

			const addedPieces = selection.addedPieces;
			if (addedPieces.length === 1) {
				if (threshold === 2) twoPieceUnmeasurableAtThisWornCount = true;
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					unmeasured: 'unmeasurable-at-this-worn-count',
				});
				continue;
			}
			/** A failed gem repair on this gear or any copy of it skips this bonus. */
			const skipRepairFailed = (err: MetaRepairError) => {
				console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: gem repair failed`, err);
				bonusNotMeasured(label, threshold, SET_BONUS_SKIP_REASONS.metaOff(err.message));
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					unmeasured: 'repair-failed',
				});
				if (threshold === 2) twoPieceFailed = true;
			};
			let gearBuild: ChainBuild;
			try {
				gearBuild = chainSwapsWithRepairs(equipment, addedPieces, gems);
			} catch (err) {
				if (!(err instanceof MetaRepairError)) throw err;
				skipRepairFailed(err);
				continue;
			}
			const builtGear = gearBuild;
			const rebuildGear = (g: GemContext) => chainSwapsWithRepairs(equipment, addedPieces, g);
			// The added pieces' sim and the same-gear check's two sims, bonus on
			// and bonus off (`measureSameGearBonus`), must wear the same gems, so
			// all three come from one `requestsPerLayout` call when the check runs.
			// `plainLayout` keeps the request without copies, or why it could not
			// be built.
			const plainLayout: { entry?: LayoutRequest | BuildFailure } = {};
			// A copy's failed gem repair skips this bonus with the repair's error, as
			// on the gear without copies; an undefined entry alone would show a
			// failed sim, and none ran.
			let layoutRepairError: MetaRepairError | undefined;
			const addedRequestsFor = async (copiesList: readonly CopyLayout[]) => {
				const entries = repairErrorOr(await requestsPerLayout(rebuildGear, builtGear, [{}, ...copiesList]));
				if (entries instanceof MetaRepairError) {
					layoutRepairError ??= entries;
					// Never read: the caller checks `layoutRepairError` first.
					const failed = { buildError: errorText(entries) };
					return copiesList.map(() => failed);
				}
				plainLayout.entry = entries[0];
				return entries.slice(1).map(requestOf);
			};

			// With `measureSetBonuses`, the same-gear check runs before the added
			// pieces' sim, so a count with no bonus here costs only the check's two
			// sims.
			let sameGear: DpsSample | undefined;
			if (measureSetBonuses) {
				const measured = await measureSameGearBonus(
					cachedSampleRun(`${label} ${threshold}pc same-gear bonus`),
					composeFor(builtGear.equipment),
					setPieceSlots(builtGear.equipment, setId),
					threshold - 1,
					addedRequestsFor,
				);
				if (layoutRepairError) {
					skipRepairFailed(layoutRepairError);
					continue;
				}
				if (!measured || isSimFailure(measured) || isBuildFailure(measured)) {
					bonusNotMeasured(
						label,
						threshold,
						!measured
							? SET_BONUS_SKIP_REASONS.measuringSimsNotBuilt
							: isSimFailure(measured)
								? SET_BONUS_SKIP_REASONS.simFailed(measured.simError)
								: SET_BONUS_SKIP_REASONS.notBuilt(measured.buildError),
					);
					results.push({
						setId,
						setName: label,
						threshold,
						piecesWorn,
						packageItemIds: addedPieces.map(p => p.itemId),
						packageDeltaDps: 0,
						unmeasured: 'sim-failed',
					});
					if (threshold === 2) twoPieceFailed = true;
					continue;
				}
				sameGear = measured;
				if (!clearsSameGearNoise(sameGear.dps, sameGear.se, cutoff)) {
					results.push({
						setId,
						setName: label,
						threshold,
						piecesWorn,
						packageItemIds: addedPieces.map(p => p.itemId),
						packageDeltaDps: 0,
						sameGearDps: sameGear.dps,
						sameGearSe: sameGear.se,
						belowNoise: true,
					});
					continue;
				}
			}
			const sameGearFields = sameGear ? { sameGearDps: sameGear.dps, sameGearSe: sameGear.se } : {};
			const addedPiecesNotMeasured = (reason: SkipReason) => {
				bonusNotMeasured(label, threshold, reason);
				results.push({
					setId,
					setName: label,
					threshold,
					piecesWorn,
					packageItemIds: addedPieces.map(p => p.itemId),
					packageDeltaDps: 0,
					...sameGearFields,
					unmeasured: 'sim-failed',
				});
				if (threshold === 2) twoPieceFailed = true;
			};

			if (!plainLayout.entry) {
				const entries = repairErrorOr(await requestsPerLayout(rebuildGear, builtGear, [{}]));
				if (entries instanceof MetaRepairError) {
					skipRepairFailed(entries);
					continue;
				}
				[plainLayout.entry] = entries;
			}
			const gearEntry = plainLayout.entry!;
			if (isBuildFailure(gearEntry)) {
				addedPiecesNotMeasured(SET_BONUS_SKIP_REASONS.notBuilt(gearEntry.buildError));
				continue;
			}
			const gearRequest = gearEntry.request;
			// The gem changes to list: the repair swaps of the gear this sim wore,
			// outside the added pieces' own slots.
			const addedSlots = new Set(addedPieces.map(p => p.slotIndex));
			const gearRepairRecolors = gearEntry.recolors.filter(s => !addedSlots.has(s.itemIndex));
			const gearOutcome = await simOrFailure(deps, gearRequest, simVersion, runOpts);
			if ('simError' in gearOutcome) {
				// No warning for a sim the Stop guard refused.
				if (!deps.signal?.aborted) {
					console.warn(`[upgrades] ${label} ${threshold}pc bonus's added pieces not measured: the sim failed`, gearOutcome.simError);
				}
				addedPiecesNotMeasured(SET_BONUS_SKIP_REASONS.simFailed(errorText(gearOutcome.simError)));
				continue;
			}

			const addedPieceSamples = addedPieces.map(p => {
				const ownDelta = ownDeltasByItemId.get(p.itemId);
				return {
					deltaDps: ownDelta?.deltaDps ?? 0,
					se: ownDelta?.se ?? 0,
				};
			});
			const addedPiecesSample: DpsSample = sampleOf(gearOutcome.observation, runOpts.iterations);
			const bonusValue = computeBonusDps({
				baseline,
				addedPiecesSample,
				addedPieceSamples,
				...(threshold === 4 && twoPcBonusDps !== undefined ? { twoPcBonusDps } : {}),
			});
			if (threshold === 2) twoPcBonusDps = bonusValue.bonusDps;

			const breaks = brokenSetBonuses(equipment, addedPieces, setId, countsAsBreak);
			let selfConfound: SelfSetConfound | undefined = threshold === 4 && twoPieceUnmeasurableAtThisWornCount ? { threshold: 2 } : undefined;
			if (selfConfound) {
				// At worn 1 the 2pc takes one added piece, so it is never measured on
				// its own, and each piece's own gain includes it: the raw 4pc value is
				// short by the 2pc once per piece after the first. Two of the pieces
				// simmed together reach only the 2pc, so the 2pc is their own gains
				// minus the pair's gain. A lost bonus of another worn set would bias
				// that, so the pieces must lose none alone or as a pair: two pieces
				// that each keep worn Malorne 3 at 2 take it to 1 together. With no
				// such pair `bonusDpsNet` stays unset.
				const breakFree = addedPieces.filter(
					p => brokenSetBonuses(equipment, [p], setId, countsAsBreak).length === 0 && ownDeltasByItemId.has(p.itemId),
				);
				const pair = breakFree
					.flatMap((a, i) => breakFree.slice(i + 1).map(b => [a, b]))
					.find(p => brokenSetBonuses(equipment, p, setId, countsAsBreak).length === 0);
				const pairTwoPiece =
					pair !== undefined
						? await measurePairTwoPiece(
								`${label} ${threshold}pc`,
								deps,
								pair,
								equipment,
								gems,
								composeFor,
								ownDeltasByItemId,
								baseline,
								simVersion,
								runOpts,
								requestsPerLayout,
								reason => bonusNotMeasured(label, 2, reason),
							)
						: undefined;
				if (pairTwoPiece) {
					const extra = addedPieces.length - 1;
					bonusValue.bonusDps += extra * pairTwoPiece.dps;
					bonusValue.se = Math.sqrt(bonusValue.se ** 2 + (extra * pairTwoPiece.se) ** 2);
					selfConfound = { threshold: 2, dps: pairTwoPiece.dps };
				}
			}
			const missingTwoPiece = measureSetBonuses && threshold === 4 && twoPieceFailed;
			results.push({
				setId,
				setName: label,
				threshold,
				piecesWorn,
				packageItemIds: addedPieces.map(p => p.itemId),
				packageDeltaDps: bonusValue.packageDeltaDps,
				...(missingTwoPiece ? {} : { bonusDps: bonusValue.bonusDps, se: bonusValue.se }),
				...sameGearFields,
				...(breaks.length > 0 ? { breaks } : {}),
				...(selfConfound ? { selfConfound } : {}),
				...(gearRepairRecolors.length > 0
					? {
							gemSubstitutions: gearRepairRecolors.map(s => ({
								itemId: s.itemId,
								itemIndex: s.itemIndex,
								socketIndex: s.socketIndex,
								from: s.from,
								to: s.to,
							})),
						}
					: {}),
			});
		}
	}

	/** The first SIM_ORDER slot each item fits; nothing is compared. */
	const firstSlotIndexByItemId = new Map<number, number>();
	for (const entry of candidates) {
		const idx = slotIndexForPoolEntry(entry);
		if (idx === undefined) continue;
		if (!firstSlotIndexByItemId.has(entry.itemId)) {
			firstSlotIndexByItemId.set(entry.itemId, idx);
		}
	}

	// Correct `bonusDps` for the worn bonuses its added pieces lose, using their
	// measured values: `bonusDpsNet = bonusDps − netInflation(terms)`. Each
	// entry's own `breaks` keep this right when the 2pc and 4pc pick different
	// slots. The terms come from the union of this entry's, the 2pc entry's and every
	// added piece's own losses. While the 2pc's pieces are a prefix of the
	// 4pc's, that union is this entry's own `breaks`; the union keeps the
	// formula whole if `selectAddedPieces` changes.
	const memberOwnBreaks = (bonus: SetBonusValue): BrokenSetBonus[] =>
		bonus.packageItemIds.flatMap(itemId => {
			const slotIndex = firstSlotIndexByItemId.get(itemId);
			const memberSetId = getItem(itemId)?.setId;
			if (slotIndex === undefined || memberSetId == null) return [];
			return brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		});
	for (const b of results) {
		if (b.bonusDps === undefined) continue;
		// A worn-1 4pc whose 2pc the pair sim did not measure is still short by
		// the 2pc once per piece after the first. Crediting it would rank rows on
		// a wrong figure, so the net stays unset and the row shows as not counted.
		if (b.selfConfound !== undefined && b.selfConfound.dps === undefined) {
			continue;
		}
		// The 2pc's terms apply only when the 4pc subtracted a measured 2pc value.
		const twoPiece =
			b.threshold === 4
				? results.find(r => r.setId === b.setId && r.threshold === 2 && r.unmeasured === undefined && r.bonusDps !== undefined)
				: undefined;
		const breaksToCorrect = new Map<string, BrokenSetBonus>();
		for (const brk of [...(b.breaks ?? []), ...(twoPiece?.breaks ?? []), ...memberOwnBreaks(b), ...(twoPiece ? memberOwnBreaks(twoPiece) : [])]) {
			breaksToCorrect.set(bonusKey(brk), brk);
		}
		const brokenByAllPieces = new Set((b.breaks ?? []).map(bonusKey));
		const brokenByAllTwoPcPieces = new Set((twoPiece?.breaks ?? []).map(bonusKey));
		const terms: InflationTerm[] = [];
		let allMeasured = true;
		for (const [key, brk] of breaksToCorrect) {
			const brokenBonusDps = brokenDpsByKey.get(key);
			if (brokenBonusDps === undefined) {
				allMeasured = false;
				break;
			}
			terms.push({
				piecesBreakingAlone: countMembersBreaking(b, brk, equipment, firstSlotIndexByItemId, countsAsBreak),
				twoPcPiecesBreakingAlone: twoPiece ? countMembersBreaking(twoPiece, brk, equipment, firstSlotIndexByItemId, countsAsBreak) : 0,
				allPiecesBreak: brokenByAllPieces.has(key) ? 1 : 0,
				allTwoPcPiecesBreak: brokenByAllTwoPcPieces.has(key) ? 1 : 0,
				brokenBonusDps,
			});
		}
		if (allMeasured) b.bonusDpsNet = b.bonusDps - netInflation(terms);
	}

	return {
		bonuses: results,
		brokenSetValues,
		brokenBonusDpsByKey: brokenDpsByKey,
		wornSetLadder,
		crossingChecks,
		firstSlotIndexByItemId,
		setIdsNotValued,
		...(setScreen ? { setScreen } : {}),
	};
}

/** What the set phase gives when it does not run, or when Stop drops it. */
export function emptySetPhase(): Awaited<ReturnType<typeof buildSetBonuses>> {
	return {
		bonuses: [],
		brokenSetValues: [],
		brokenBonusDpsByKey: new Map(),
		wornSetLadder: [],
		crossingChecks: [],
		firstSlotIndexByItemId: new Map(),
		setIdsNotValued: [],
	};
}
