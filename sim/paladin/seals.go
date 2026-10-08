package paladin

import (
	"fmt"
	"time"

	"github.com/wowsims/tbc/sim/common/shared"
	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	"github.com/wowsims/tbc/sim/core/stats"
)

type proc struct {
	spellID int32
	value   float64
	coeff   float64
}

type judge struct {
	spellID   int32
	minDamage float64
	maxDamage float64
	coeff     float64
}

type seal struct {
	rank     int32
	spellID  int32
	manaCost float64
	proc     proc
	judge    judge
}

func (seal seal) GetRank() int32 { return seal.rank }

func (seal seal) GetSpellID() int32 { return seal.spellID }

func (seal seal) GetRankLabel() string {
	return fmt.Sprintf("Rank %d", seal.rank)
}

// Seal of Justice is the one family the client charges nothing for, on either rank.
func sealMana(s seal, mana float64) seal {
	s.manaCost = mana
	return s
}

// Everything the client states, judgement damage included - Righteousness, the Crusader and Command
// all state theirs.
func sealOf(seals, judges shared.SpellDataTable, rank int32, p proc) seal {
	j := judges.ByRank(rank)
	return sealWithJudgement(seals, judges, rank, p, judge{
		minDamage: shared.SpellDataMin(j.Direct),
		maxDamage: shared.SpellDataMax(j.Direct),
		coeff:     shared.SpellDataCoef(j.Direct),
	})
}

// For the three families whose judgement damage has to be supplied. A seal is three spells for one
// rank, so it keeps its own row rather than becoming a SpellData. The proc always comes in by hand -
// no family has its coefficient in the client.
func sealWithJudgement(seals, judges shared.SpellDataTable, rank int32, p proc, j judge) seal {
	s := seals.ByRank(rank)
	j.spellID = judges.ByRank(rank).SpellID
	return seal{rank: rank, spellID: s.SpellID, manaCost: float64(s.Cost), proc: p, judge: j}
}

var SealOfRighteousnessRanks = sealRankMap{
	// The proc value is the seal's own effect 0, exact on all nine ranks; its coefficient is not in
	// the client at all. The judgement damage matches the hand rows on ranks 2-9; rank 1 was a flat
	// 26 against the client's 25-26, the same one-die-side roll Immolate rank 9 and Water Shield
	// turned out to be, and the client's is taken.
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 1, proc{spellID: 25742, value: spellData.SealOfRighteousness.ByRank(1).Effects[0].Value, coeff: 0.029}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 2, proc{spellID: 25740, value: spellData.SealOfRighteousness.ByRank(2).Effects[0].Value, coeff: 0.063}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 3, proc{spellID: 25739, value: spellData.SealOfRighteousness.ByRank(3).Effects[0].Value, coeff: 0.093}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 4, proc{spellID: 25738, value: spellData.SealOfRighteousness.ByRank(4).Effects[0].Value, coeff: 0.1}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 5, proc{spellID: 25737, value: spellData.SealOfRighteousness.ByRank(5).Effects[0].Value, coeff: 0.1}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 6, proc{spellID: 25736, value: spellData.SealOfRighteousness.ByRank(6).Effects[0].Value, coeff: 0.1}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 7, proc{spellID: 25735, value: spellData.SealOfRighteousness.ByRank(7).Effects[0].Value, coeff: 0.1}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 8, proc{spellID: 25713, value: spellData.SealOfRighteousness.ByRank(8).Effects[0].Value, coeff: 0.1}),
	sealOf(spellData.SealOfRighteousness, spellData.JudgementOfRighteousness, 9, proc{spellID: 27156, value: spellData.SealOfRighteousness.ByRank(9).Effects[0].Value, coeff: 0.1}),
}

var SealOfLightRanks = sealRankMap{
	// These derive - the heal is on a same-name spell the client never grants, 20185 to 20267 - but
	// every rule that reaches it also breaks something: by skill line puts Blizzard's tick damage on
	// the channel, by ungranted name gives warrior Enrage a Direct off a creature ability.
	sealWithJudgement(spellData.SealOfLight, spellData.JudgementOfLight, 1, proc{spellID: 20167, value: 39, coeff: 0.0}, judge{minDamage: 25, maxDamage: 25, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfLight, spellData.JudgementOfLight, 2, proc{spellID: 20333, value: 53, coeff: 0.0}, judge{minDamage: 34, maxDamage: 34, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfLight, spellData.JudgementOfLight, 3, proc{spellID: 20334, value: 76, coeff: 0.0}, judge{minDamage: 49, maxDamage: 49, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfLight, spellData.JudgementOfLight, 4, proc{spellID: 20340, value: 94, coeff: 0.0}, judge{minDamage: 61, maxDamage: 61, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfLight, spellData.JudgementOfLight, 5, proc{spellID: 27161, value: 133, coeff: 0.0}, judge{minDamage: 95, maxDamage: 95, coeff: 0.0}),
}

var SealOfWisdomRanks = sealRankMap{
	sealWithJudgement(spellData.SealOfWisdom, spellData.JudgementOfWisdom, 1, proc{spellID: 20168, value: 50, coeff: 0.0}, judge{minDamage: 33, maxDamage: 33, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfWisdom, spellData.JudgementOfWisdom, 2, proc{spellID: 20350, value: 71, coeff: 0.0}, judge{minDamage: 46, maxDamage: 46, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfWisdom, spellData.JudgementOfWisdom, 3, proc{spellID: 20351, value: 90, coeff: 0.0}, judge{minDamage: 59, maxDamage: 59, coeff: 0.0}),
	sealWithJudgement(spellData.SealOfWisdom, spellData.JudgementOfWisdom, 4, proc{spellID: 27167, value: 121, coeff: 0.0}, judge{minDamage: 74, maxDamage: 74, coeff: 0.0}),
}

var SealOfJusticeRanks = sealRankMap{
	// The judgement stuns and deals no damage, which is why both ranks are zero where the client gives
	// rank 2 a 7. The client states no mana cost for either rank; the sim charges 10, so that stays.
	sealMana(sealWithJudgement(spellData.SealOfJustice, spellData.JudgementOfJustice, 1, proc{spellID: 20170}, judge{}), 10),
	sealMana(sealWithJudgement(spellData.SealOfJustice, spellData.JudgementOfJustice, 2, proc{spellID: 20170}, judge{}), 10),
}

var SealOfTheCrusaderRanks = sealRankMap{
	// The attack power is the effect's high end, not its low one: rank 1's base is 39.2 and the game
	// buffs for 41. Exact on all seven ranks, and so is the judgement damage.
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 1, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(1).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 2, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(2).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 3, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(3).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 4, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(4).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 5, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(5).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 6, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(6).Effects[0].High()}),
	sealOf(spellData.SealOfTheCrusader, spellData.JudgementOfTheCrusader, 7, proc{spellID: 21082, value: spellData.SealOfTheCrusader.ByRank(7).Effects[0].High()}),
}

var SealOfCommandRanks = sealRankMap{
	// The 70 lives on proc spell 20424, which has no rank subtext and so is in no table. The
	// judgement damage is the client's full number; registerSealOfCommandRank halves it.
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 1, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 2, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 3, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 4, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 5, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
	sealOf(spellData.SealOfCommand, spellData.JudgementOfCommand, 6, proc{spellID: 20424, value: 0.70, coeff: 0.29}),
}

func (paladin *Paladin) registerSeals() {
	SealOfRighteousnessRanks.RegisterAll(paladin.registerSealOfRighteousness)
	SealOfLightRanks.RegisterAll(paladin.registerSealOfLight)
	SealOfWisdomRanks.RegisterAll(paladin.registerSealOfWisdom)
	SealOfJusticeRanks.RegisterAll(paladin.registerSealOfJustice)
	SealOfTheCrusaderRanks.RegisterAll(paladin.registerSealOfTheCrusader)
	paladin.registerSealOfBlood()
	paladin.registerSealOfVengeance()
}

// Seal Twist
const TwistTag = "Twistable"

// Command -> Blood
// Command -> Righteousness
// Command -> Wisdom
// Command -> Light
// Command -> Justice

// Blood -> X

// Righteous -> Command
// Righteous -> Blood
// Righteous -> Wisdom
// Righteous -> Light
// Righteous -> Justice

// Wisdom -> X

// Light -> X

// Justice -> X
func (paladin *Paladin) applySeal(newSeal *core.Aura, sealSpell *core.Spell, judgement *core.Spell, sim *core.Simulation) {
	if paladin.CurrentSeal != nil {
		newSealLabel := newSeal.ActionID.SpellID
		if newSealLabel == 0 {
			newSealLabel = newSeal.ActionIDForProc.SpellID
		}

		currentSealLabel := paladin.CurrentSeal.ActionID.SpellID
		if currentSealLabel == 0 {
			currentSealLabel = paladin.CurrentSeal.ActionIDForProc.SpellID
		}
		// If they are recasting the same seal, reactivate or refresh
		if newSealLabel == currentSealLabel {
			paladin.CurrentSeal.Activate(sim)
			return
		}
	}

	// Twisting only occurs when current seal is Command or Righteousness
	if paladin.CurrentSeal.IsActive() {
		if paladin.CurrentSeal.Tag == TwistTag {
			paladin.PreviousSealSpell = sealSpell
			paladin.PreviousSeal = paladin.CurrentSeal
			paladin.PreviousJudgement = paladin.CurrentJudgement
			pendingAction := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + (time.Millisecond * 399),
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					paladin.PreviousSeal.Deactivate(sim)
				},
			})
			sim.AddPendingAction(pendingAction)
		} else {
			paladin.CurrentSeal.Deactivate(sim)
		}
	}

	paladin.CurrentSealSpell = sealSpell
	paladin.CurrentSeal = newSeal
	paladin.CurrentJudgement = judgement
	paladin.CurrentSeal.Activate(sim)
}

// Seal of Righteousness
// https://www.wowhead.com/tbc/spell=21084
//
// Fills the Paladin with divine spirit for 30 sec, granting each melee attack
// additional Holy damage. Only one Seal can be active on the Paladin at any one time.
//
// Unleashing this Seal's energy will judge an enemy, instantly causing Holy damage.
func (paladin *Paladin) registerSealOfRighteousness(seal seal) {
	// ~~~~~~~~~ SEASON OF DISCOVERY DESCRIPTION, INFO SHOULD BE VERIFIED ~~~~~~~~~

	/*
	* Seal of Righteousness is a Spell/Aura that when active makes the paladin capable of procing
	* two different SpellIDs depending on a paladin's casted spell or melee swing.
	*
	* (Judgement of Righteousness):
	*   - Deals flat damage that is affected by Improved SoR talent, and
	*     has a spellpower scaling that is unaffected by that talent.
	*   - Targets magic defense and rolls to hit and crit.
	*
	* (Seal of Righteousness):
	*   - Procs from white hits.
	*   - Cannot miss or be dodged/parried/blocked if the underlying white hit lands.
	*   - Deals damage that is a function of weapon speed, and spellpower.
	*   - Calculates damage including spellpower scaling but ignoring damage multipliers,
	*      then feeds that value as base damage into the proc spell.
	 */

	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskSpellDamage,
		Flags:          core.SpellFlagMeleeMetrics | core.SpellFlagBinary,
		ClassSpellMask: SpellMaskJudgementOfRighteousness,

		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		BonusCoefficient: seal.judge.coeff,

		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			flags := spell.Flags
			baseDamage := sim.Roll(seal.judge.minDamage, seal.judge.maxDamage)
			result := spell.CalcDamage(sim, target, baseDamage, spell.OutcomeMagicHitAndCrit)

			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					currentFlags := spell.Flags
					spell.Flags = flags
					spell.DealDamage(sim, result)
					spell.Flags = currentFlags
				},
			})

			sim.AddPendingAction(action)
		},
	})

	// Canonical Seal of Righteousness proc formula (Maintankadin / EJ, matches in-game testing):
	//   1H: damage = (0.85 * SoRcoef * Speed) - (QualityModifier * Speed * 0.03) + (0.03 * AvgWeaponDmg) + (0.092 * Speed * SP)
	//   2H: damage = (1.20 * SoRcoef * Speed) - (QualityModifier * Speed * 0.03) + (0.03 * AvgWeaponDmg) + (0.108 * Speed * SP)
	sorCoef := seal.proc.value * 1.2 * 1.03 / 100
	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:    core.ActionID{SpellID: seal.proc.spellID},
		SpellSchool: core.SpellSchoolHoly,
		DefenseType: core.DefenseTypeMelee,
		ProcMask:    core.ProcMaskMeleeMHSpecial,
		// The damage spells (25713 .. 27156) carry Suppress Weapon Procs and are procs: weapon procs
		// and auras without Can Proc From Procs never hear them.
		Flags:          core.SpellFlagMeleeMetrics | core.SpellFlagPassiveSpell | core.SpellFlagProc | core.SpellFlagSuppressWeaponProcs,
		ClassSpellMask: SpellMaskSealOfRighteousness,

		DamageMultiplier: 1,
		ThreatMultiplier: 1,

		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			mh := paladin.MainHand()

			baseCoef := 0.85
			spCoef := 0.092
			if mh.HandType == proto.HandType_HandTypeTwoHand {
				baseCoef = 1.2
				spCoef = 0.108
			}

			speed := mh.SwingSpeed
			spell.BonusCoefficient = spCoef * speed

			avgWeaponDmg := paladin.AutoAttacks.MH().AverageDamage()
			flatDamage := baseCoef*sorCoef*speed - mh.QualityModifier*speed*0.03 + 0.03*avgWeaponDmg
			result := spell.CalcDamage(sim, target, flatDamage, spell.OutcomeAlwaysHit)

			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					spell.DealDamage(sim, result)
				},
			})

			sim.AddPendingAction(action)
		},
	})

	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Righteousness" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID:        core.ActionID{SpellID: seal.spellID},
		MetricsActionID: core.ActionID{SpellID: seal.spellID},
		Duration:        time.Second * 30,
		Outcome:         core.OutcomeLanded,
		Callback:        core.CallbackOnSpellHitDealt,
		ProcMask:        core.ProcMaskMeleeWhiteHit,
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			procSpell.Cast(sim, result.Target)
		},
	})
	aura.Tag = TwistTag

	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.spellID},
		ClassSpellMask: SpellMaskSealOfRighteousness,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		Rank:           seal.rank,

		DamageMultiplier: 1,
		ThreatMultiplier: 1,

		ManaCost: core.ManaCostOptions{
			FlatCost: int32(seal.manaCost),
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{
				GCD: core.GCDDefault,
			},
		},

		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of Light
// https://www.wowhead.com/tbc/spell=20165
//
// Fills the Paladin with divine light for 30 sec, giving each melee attack
// a chance to heal the Paladin. Only one Seal can be active on the Paladin
// at any one time.
//
// Unleashing this Seal's energy will judge an enemy for 20 sec, granting
// attacks against the judged enemy a chance to heal the attacker.
func (paladin *Paladin) registerSealOfLight(seal seal) {
	judgementOfLightAuras := paladin.NewEnemyAuraArray(core.JudgementOfLightAura)
	paladin.JudgementAuras = append(paladin.JudgementAuras, judgementOfLightAuras)

	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagBinary,
		ClassSpellMask:   SpellMaskJudgementOfLight,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealOutcome(sim, target, spell.OutcomeAlwaysHit)
			judgementOfLightAuras.Get(target).Activate(sim)
		},
	})

	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.proc.spellID},
		ClassSpellMask:   SpellMaskSealOfLight,
		SpellSchool:      core.SpellSchoolHoly,
		ProcMask:         core.ProcMaskSpellHealing,
		Flags:            core.SpellFlagHelpful | core.SpellFlagPassiveSpell | core.SpellFlagProc, // 20167, 20333, 20334, 20340, 27161 lack Not a Proc.
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealHealing(sim, target, seal.proc.value, spell.OutcomeAlwaysHit)
		},
	})

	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Light" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID:        core.ActionID{SpellID: seal.spellID},
		MetricsActionID: core.ActionID{SpellID: seal.spellID},
		Duration:        time.Second * 30,
		Outcome:         core.OutcomeLanded,
		Callback:        core.CallbackOnSpellHitDealt,
		ProcMask:        core.ProcMaskMeleeWhiteHit,
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			procSpell.Cast(sim, result.Target)
		},
	})

	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.spellID},
		ClassSpellMask: SpellMaskSealOfLight,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		Rank:           seal.rank,
		ManaCost: core.ManaCostOptions{
			FlatCost: int32(seal.manaCost),
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{GCD: core.GCDDefault},
		},
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of Wisdom
// https://www.wowhead.com/tbc/spell=20166
//
// Fills the Paladin with divine wisdom for 30 sec, giving each melee attack
// a chance to restore mana to the Paladin. Only one Seal can be active on
// the Paladin at any one time.
//
// Unleashing this Seal's energy will judge an enemy for 20 sec, granting
// attacks against the judged enemy a chance to restore mana to the attacker.
func (paladin *Paladin) registerSealOfWisdom(seal seal) {
	judgementOfWisdomAuras := paladin.NewEnemyAuraArray(core.JudgementOfWisdomAura)
	paladin.JudgementAuras = append(paladin.JudgementAuras, judgementOfWisdomAuras)

	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagBinary,
		ClassSpellMask:   SpellMaskJudgementOfWisdom,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealOutcome(sim, target, spell.OutcomeAlwaysHit)
			judgementOfWisdomAuras.Get(target).Activate(sim)
		},
	})
	sealManaMetrics := paladin.Unit.NewManaMetrics(core.ActionID{SpellID: seal.proc.spellID})
	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.proc.spellID},
		ClassSpellMask:   SpellMaskSealOfWisdom,
		SpellSchool:      core.SpellSchoolHoly,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagHelpful | core.SpellFlagPassiveSpell | core.SpellFlagProc, // 20168, 20350, 20351, 27167 lack Not a Proc.
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			if spell.Unit.HasManaBar() {
				spell.Unit.AddMana(sim, seal.proc.value, sealManaMetrics)
			}
		},
	})
	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Wisdom" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID:        core.ActionID{SpellID: seal.spellID},
		MetricsActionID: core.ActionID{SpellID: seal.spellID},
		Duration:        time.Second * 30,
		Outcome:         core.OutcomeLanded,
		Callback:        core.CallbackOnSpellHitDealt,
		ProcMask:        core.ProcMaskMeleeWhiteHit,
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			procSpell.Cast(sim, result.Target)
		},
	})
	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.spellID},
		ClassSpellMask: SpellMaskSealOfWisdom,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		Rank:           seal.rank,
		ManaCost: core.ManaCostOptions{
			FlatCost: int32(seal.manaCost),
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{GCD: core.GCDDefault},
		},
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of Justice
// https://www.wowhead.com/tbc/spell=20164
//
// Fills the Paladin with the spirit of justice for 30 sec, giving each melee
// attack a chance to stun the target for 2 sec. Only one Seal can be active
// on the Paladin at any one time.
//
// Unleashing this Seal's energy will judge an enemy for 20 sec, preventing
// them from fleeing.
func (paladin *Paladin) registerSealOfJustice(seal seal) {
	registerJoJDebuff := func(target *core.Unit) *core.Aura {
		return target.GetOrRegisterAura(core.Aura{
			Label:    "Judgement of Justice",
			ActionID: core.ActionID{SpellID: seal.judge.spellID},
			Tag:      JudgementAuraTag,
			Duration: time.Second * 20,
			OnSpellHitTaken: func(aura *core.Aura, sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
				if spell.ProcMask.Matches(core.ProcMaskMeleeWhiteHit) {
					aura.Refresh(sim)
				}
			},
		})
	}

	judgementOfJusticeAuras := paladin.NewEnemyAuraArray(registerJoJDebuff)
	paladin.JudgementAuras = append(paladin.JudgementAuras, judgementOfJusticeAuras)

	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagBinary,
		ClassSpellMask:   SpellMaskJudgementOfJustice,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealOutcome(sim, target, spell.OutcomeAlwaysHit)
			judgementOfJusticeAuras.Get(target).Activate(sim)
		},
	})
	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.proc.spellID},
		ClassSpellMask:   SpellMaskSealOfJustice,
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagPassiveSpell | core.SpellFlagProc, // 20170 lacks Not a Proc.
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealOutcome(sim, target, spell.OutcomeAlwaysHit)
		},
	})
	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Justice" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID:        core.ActionID{SpellID: seal.spellID},
		MetricsActionID: core.ActionID{SpellID: seal.spellID},
		Duration:        time.Second * 30,
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			procSpell.Cast(sim, result.Target)
		},
	})
	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.spellID},
		ClassSpellMask: SpellMaskSealOfJustice,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		Rank:           seal.rank,
		ManaCost: core.ManaCostOptions{
			BaseCostPercent: seal.manaCost,
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{GCD: core.GCDDefault},
		},
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of the Crusader
// https://www.wowhead.com/tbc/spell=21082
//
// Fills the Paladin with the spirit of a crusader for 30 sec, increasing
// attack speed but reducing damage caused by each weapon hit. The
// Paladin also causes additional threat. Only one Seal can be active on
// the Paladin at any one time.
//
// Unleashing this Seal's energy will judge an enemy for 20 sec, increasing
// Holy damage taken from all sources.
func (paladin *Paladin) registerSealOfTheCrusader(seal seal) {
	percentBonus := core.Ternary(paladin.CouldHaveSetBonus(ItemSetJusticarBattlegear, 2), 1.15, 1.0)
	flatBonus := 0.0
	if paladin.Ranged().ID == 23203 { //https://www.wowhead.com/tbc/item=23203/libram-of-fervor
		flatBonus += 33.0
	} else if paladin.Ranged().ID == 27949 || paladin.Ranged().ID == 27983 { //https://www.wowhead.com/tbc/item=27949/libram-of-zeal
		flatBonus += 47.0
	}

	judgementOfTheCrusaderAuras := paladin.NewEnemyAuraArray(func(target *core.Unit) *core.Aura {
		return core.ImprovedSealOfTheCrusaderAura(target, 1, paladin.Talents.ImprovedSealOfTheCrusader, flatBonus, percentBonus)
	})

	paladin.JudgementAuras = append(paladin.JudgementAuras, judgementOfTheCrusaderAuras)

	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagBinary,
		ClassSpellMask:   SpellMaskJudgementOfTheCrusader,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			spell.CalcAndDealOutcome(sim, target, spell.OutcomeAlwaysHit)
			judgementOfTheCrusaderAuras.Get(target).Activate(sim)
		},
	})

	aura := paladin.RegisterAura(core.Aura{
		Label:    "Seal of the Crusader" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID: core.ActionID{SpellID: seal.spellID},
		Duration: time.Second * 30,
	}).
		AttachMultiplyMeleeSpeed(1.4).
		AttachSpellMod(core.SpellModConfig{
			ProcMask:   core.ProcMaskMeleeMHAuto,
			Kind:       core.SpellMod_DamageDone_Flat,
			FloatValue: -0.4,
		}).
		AttachStatBuff(stats.AttackPower, seal.proc.value)

	paladin.RegisterSpell(core.SpellConfig{
		ActionID:         aura.ActionID,
		ClassSpellMask:   SpellMaskSealOfTheCrusader,
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagAPL,
		Rank:             seal.rank,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ManaCost: core.ManaCostOptions{
			FlatCost: int32(seal.manaCost),
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{GCD: core.GCDDefault},
		},
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
		RelatedSelfBuff: aura,
	})
}

// Seal of Blood
// https://www.wowhead.com/tbc/spell=31892
//
// All melee attacks deal additional Holy damage equal to 35% of normal weapon damage, but the Paladin loses health equal to 10% of the total damage inflicted.
//
// Unleashing this Seal's energy will judge an enemy, instantly causing 295 to 325 Holy damage at the cost of health equal to 33% of the damage caused.
func (paladin *Paladin) registerSealOfBlood() {
	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: 31898},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMelee,
		ProcMask:         core.ProcMaskMeleeMHSpecial,
		Flags:            core.SpellFlagMeleeMetrics,
		ClassSpellMask:   SpellMaskJudgementOfBlood,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		BonusCoefficient: 0.429,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			flags := spell.Flags
			baseDamage := sim.Roll(295, 325)
			result := spell.CalcDamage(sim, target, baseDamage, spell.OutcomeMeleeSpecialCritOnly)
			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					currentFlags := spell.Flags
					spell.Flags = flags
					spell.DealDamage(sim, result)
					spell.Flags = currentFlags
				},
			})
			sim.AddPendingAction(action)
		},
	})
	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: 31893},
		ClassSpellMask: SpellMaskSealOfBlood,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMelee,
		ProcMask:       core.ProcMaskMeleeMHSpecial,
		// 31893 carries Suppress Weapon Procs and is a proc, like Seal of Righteousness.
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagPassiveSpell | core.SpellFlagProc | core.SpellFlagSuppressWeaponProcs,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			baseDamage := spell.Unit.MHWeaponDamage(sim, spell.MeleeAttackPower(target)) * 0.35
			result := spell.CalcDamage(sim, target, baseDamage, spell.OutcomeMeleeSpecialHitAndCrit)
			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					spell.DealDamage(sim, result)
				},
			})
			sim.AddPendingAction(action)
		},
	})
	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Blood" + paladin.Label,
		ActionID:        core.ActionID{SpellID: 31892},
		MetricsActionID: core.ActionID{SpellID: 31892},
		Duration:        time.Second * 30,
		Callback:        core.CallbackOnSpellHitDealt,
		Outcome:         core.OutcomeLanded,
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			if !spell.ProcMask.Matches(core.ProcMaskMeleeWhiteHit) && !spell.Matches(SpellMaskSealOfCommand) {
				return
			}

			procSpell.Cast(sim, result.Target)
		},
	})
	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: 31892},
		ClassSpellMask: SpellMaskSealOfBlood,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		ManaCost: core.ManaCostOptions{
			FlatCost: 210,
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{
				GCD: core.GCDDefault,
			},
		},
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of Vengeance
// https://www.wowhead.com/tbc/spell=31801
//
// Fills the Paladin with holy power, granting each melee attack a chance to cause 150 Holy damage over 15 sec.
// This effect can stack up to 5 times.
// Only one Seal can be active on the Paladin at any one time.
// Lasts 30 sec.
//
// Unleashing this Seal's energy will judge an enemy, instantly causing 120 Holy damage per application of Holy Vengeance.
func (paladin *Paladin) registerSealOfVengeance() {
	holyVengeanceTag := "Holy Vengeance"
	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: 31804},
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagMeleeMetrics,
		ClassSpellMask:   SpellMaskJudgementOfVengeance,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		BonusCoefficient: 0.429,
		ExtraCastCondition: func(sim *core.Simulation, target *core.Unit) bool {
			return target.GetActiveAuraWithTag(holyVengeanceTag) != nil
		},
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			damage := 120 * float64(target.GetActiveAuraWithTag(holyVengeanceTag).GetStacks())
			result := spell.CalcDamage(sim, target, damage, spell.OutcomeMagicHitAndCrit)
			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					spell.DealDamage(sim, result)
				},
			})
			sim.AddPendingAction(action)
		},
	})
	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: 42463},
		ClassSpellMask:   SpellMaskSealOfVengeance,
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagPassiveSpell | core.SpellFlagProc,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			attackTable := spell.Unit.AttackTables[target.UnitIndex]
			damage := (10 + spell.BonusDamage(attackTable)*0.034/3) * paladin.MainHand().SwingSpeed
			spell.CalcAndDealDamage(sim, target, damage, spell.OutcomeMagicHit)
		},
	})
	holyVengeanceDot := paladin.RegisterSpell(core.SpellConfig{
		ActionID:         core.ActionID{SpellID: 31803},
		ClassSpellMask:   SpellMaskSealOfVengeance,
		SpellSchool:      core.SpellSchoolHoly,
		DefenseType:      core.DefenseTypeMagic,
		ProcMask:         core.ProcMaskEmpty,
		Flags:            core.SpellFlagPassiveSpell | core.SpellFlagMeleeMetrics | core.SpellFlagProc,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		Dot: core.DotConfig{
			Aura: core.Aura{
				Label:     "Holy Vengeance" + paladin.Label,
				Tag:       holyVengeanceTag,
				ActionID:  core.ActionID{SpellID: 31803},
				MaxStacks: 5,
			},
			NumberOfTicks: 5,
			TickLength:    time.Second * 3,
			OnSnapshot: func(sim *core.Simulation, target *core.Unit, dot *core.Dot) {
				attackTable := dot.Spell.Unit.AttackTables[target.UnitIndex]
				dot.Snapshot(target, 30+dot.Spell.BonusDamage(attackTable)*0.034*float64(dot.GetStacks()))
			},
			OnTick: func(sim *core.Simulation, target *core.Unit, dot *core.Dot) {
				dot.CalcAndDealPeriodicSnapshotDamage(sim, target, dot.OutcomeTick)
			},
		},
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			hitResult := spell.CalcOutcome(sim, target, spell.OutcomeMagicHit)
			if !hitResult.Landed() {
				spell.DealOutcome(sim, hitResult)
				return
			}

			dot := spell.Dot(target)
			if dot.IsActive() {
				dot.AddStack(sim)
				dot.TakeSnapshot(sim)
				dot.Refresh(sim)
			} else {
				dot.Apply(sim)
				dot.SetStacks(sim, 1)
				dot.TakeSnapshot(sim)
			}
		},
	})
	// 20 PPM measured from TBC Anniversary logs (2026-09): 63 paladins, 6.3k landed swings with the seal up,
	// 19.9 PPM at 1.6, 1.8 and 2.7 weapon speed alike. Hand counts that miss resisted applications land near 15.
	aura := paladin.MakeProcTriggerAura(core.ProcTrigger{
		Name:            "Seal of Vengeance" + paladin.Label,
		ActionID:        core.ActionID{SpellID: 31801},
		MetricsActionID: core.ActionID{SpellID: 31801},
		Duration:        time.Second * 30,
		Callback:        core.CallbackOnSpellHitDealt,
		ProcMask:        core.ProcMaskMeleeWhiteHit,
		Outcome:         core.OutcomeLanded,
		DPM:             paladin.NewStaticLegacyPPMManager(20, core.ProcMaskMeleeWhiteHit),
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			dot := holyVengeanceDot.Dot(result.Target)
			if dot.IsActive() && dot.GetStacks() == 5 {
				procSpell.Cast(sim, result.Target)
			}

			holyVengeanceDot.Cast(sim, result.Target)
		},
	})
	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: 31801},
		ClassSpellMask: SpellMaskSealOfVengeance,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		ManaCost: core.ManaCostOptions{
			FlatCost: 250,
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{
				GCD: core.GCDDefault,
			},
		},
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}

// Seal of Command
// https://www.wowhead.com/tbc/spell=20375
//
// Gives the Paladin a chance to deal additional Holy damage equal to 70%
// of normal weapon damage. Only one Seal can be active on the Paladin at
// any one time. Lasts 30 sec.
//
// Unleashing this Seal's energy will judge an enemy, instantly causing
// 228 to 252 Holy damage, 456 to 504 if the target is stunned or incapacitated.
//
// The table carries 456-504, which is what the client states; the half is applied at cast time
// against PseudoStats.Stunned. No encounter stuns the boss, so the halved branch is the only one
// any preset takes - the stunned path ships untested.
func (paladin *Paladin) registerSealOfCommandRank(seal seal) {
	minDamage := seal.judge.minDamage
	maxDamage := seal.judge.maxDamage
	judgeSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:    core.ActionID{SpellID: seal.judge.spellID},
		SpellSchool: core.SpellSchoolHoly,
		// The judgement spell itself (20425 .. 27172) is a dummy that triggers the damage spell
		// (20467, 20963 .. 20966, 27171), and that one is Melee in SpellCategories.
		DefenseType:      core.DefenseTypeMelee,
		ProcMask:         core.ProcMaskMeleeMHSpecial,
		Flags:            core.SpellFlagMeleeMetrics,
		ClassSpellMask:   SpellMaskJudgementOfCommand,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		BonusCoefficient: seal.judge.coeff,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			// The client states the stunned number and the game halves it otherwise, so the roll comes
			// first and the halving second - rolling a halved range is not the same distribution.
			baseDamage := sim.Roll(minDamage, maxDamage)
			if !target.PseudoStats.Stunned {
				baseDamage /= 2
			}
			result := spell.CalcDamage(sim, target, baseDamage, spell.OutcomeMeleeSpecialCritOnly)
			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					spell.DealDamage(sim, result)
				},
			})
			sim.AddPendingAction(action)
		},
	})

	procSpell := paladin.RegisterSpell(core.SpellConfig{
		ActionID:       core.ActionID{SpellID: seal.proc.spellID},
		ClassSpellMask: SpellMaskSealOfCommand,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMelee,
		ProcMask:       core.ProcMaskMeleeMHSpecial,
		// 20424 carries Not a Proc: it is an ability hit to every listener, weapon procs included.
		Flags:            core.SpellFlagMeleeMetrics | core.SpellFlagPassiveSpell,
		DamageMultiplier: 1,
		ThreatMultiplier: 1,
		BonusCoefficient: seal.proc.coeff,
		ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
			baseDamage := spell.Unit.MHWeaponDamage(sim, spell.MeleeAttackPower(target)) * seal.proc.value
			result := spell.CalcDamage(sim, target, baseDamage, spell.OutcomeMeleeSpecialHitAndCrit)
			action := core.NewDelayedAction(core.DelayedActionOptions{
				DoAt:     sim.CurrentTime + core.SpellBatchWindow,
				Priority: core.ActionPriorityLow,
				OnAction: func(sim *core.Simulation) {
					spell.DealDamage(sim, result)
				},
			})
			sim.AddPendingAction(action)
		},
	})

	aura := paladin.RegisterAura(core.Aura{
		Label:    "Seal of Command" + paladin.Label + " " + seal.GetRankLabel(),
		ActionID: core.ActionID{SpellID: seal.spellID},
		Duration: time.Second * 30,
		Tag:      TwistTag,
	}).AttachProcTrigger(core.ProcTrigger{
		Outcome:  core.OutcomeLanded,
		ProcMask: core.ProcMaskMeleeWhiteHit,
		Callback: core.CallbackOnSpellHitDealt,
		ICD:      time.Second * 1,
		DPM:      paladin.NewLegacyPPMManager(7, core.ProcMaskMeleeWhiteHit),
		Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
			procSpell.Cast(sim, result.Target)
		},
	})

	paladin.RegisterSpell(core.SpellConfig{
		ActionID:       aura.ActionID,
		ClassSpellMask: SpellMaskSealOfCommand,
		SpellSchool:    core.SpellSchoolHoly,
		DefenseType:    core.DefenseTypeMagic,
		ProcMask:       core.ProcMaskEmpty,
		Flags:          core.SpellFlagAPL,
		Rank:           seal.rank,
		ManaCost: core.ManaCostOptions{
			FlatCost: int32(seal.manaCost),
		},
		Cast: core.CastConfig{
			DefaultCast: core.Cast{GCD: core.GCDDefault},
		},
		ApplyEffects: func(sim *core.Simulation, _ *core.Unit, spell *core.Spell) {
			paladin.applySeal(aura, spell, judgeSpell, sim)
		},
	})
}
