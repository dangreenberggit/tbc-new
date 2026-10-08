package tbc

import (
	"time"

	"github.com/wowsims/tbc/sim/common/itemhelpers"
	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	"github.com/wowsims/tbc/sim/core/stats"
)

func init() {
	// Despair
	itemhelpers.CreateWeaponProcSpell(itemhelpers.WeaponProcSpell{
		ItemID: 28573,
		Name:   "Despair",
		PPM:    1,
		Spell: func(character *core.Character) *core.Spell {
			return character.GetOrRegisterSpell(core.SpellConfig{
				ActionID:    core.ActionID{SpellID: 34580},
				ProcMask:    core.ProcMaskEmpty,
				SpellSchool: core.SpellSchoolPhysical,
				DefenseType: core.DefenseTypeMelee,
				Flags:       core.SpellFlagPassiveSpell | core.SpellFlagIgnoreResists,

				DamageMultiplier: 1,
				ThreatMultiplier: 1,

				ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
					spell.CalcAndDealDamage(sim, target, 600, spell.OutcomeMeleeSpecialNoBlockDodgeParry)
				},
			})
		},
	})

	// Bonereaver's Edge
	itemhelpers.CreateWeaponProcTrigger(itemhelpers.WeaponProcTrigger{
		ItemID: 17076,
		Name:   "Bonereaver's Edge",
		PPM:    2,
		Handler: func(character *core.Character) core.ProcHandler {
			arpAura := core.MakeStackingAura(
				character,
				core.StackingStatAura{
					Aura: core.Aura{
						Label:     "Bonereaver's Edge",
						ActionID:  core.ActionID{SpellID: 21153},
						Duration:  time.Second * 10,
						MaxStacks: 3,
					},
					BonusPerStack: stats.Stats{
						stats.ArmorPenetration: 700,
					},
				},
			)

			return func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
				arpAura.Activate(sim)
				arpAura.AddStack(sim)
			}
		},
	})

	// Rod of the Sun King
	itemhelpers.CreateWeaponProcSpell(itemhelpers.WeaponProcSpell{
		ItemID: 29996,
		Name:   "Rod of the Sun King",
		PPM:    1,
		Spell: func(character *core.Character) *core.Spell {
			actionID := core.ActionID{SpellID: 36070}
			var resourceMetrics *core.ResourceMetrics = nil
			if character.HasEnergyBar() {
				resourceMetrics = character.NewEnergyMetrics(actionID)
			} else if character.HasRageBar() {
				resourceMetrics = character.NewRageMetrics(actionID)
			} else {
				return nil
			}

			return character.GetOrRegisterSpell(core.SpellConfig{
				ActionID: actionID,
				ProcMask: core.ProcMaskEmpty,
				Flags:    core.SpellFlagNoOnCastComplete | core.SpellFlagNoMetrics,

				ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
					if character.HasEnergyBar() {
						character.AddEnergy(sim, 10, resourceMetrics)
					} else if character.HasRageBar() {
						character.AddRage(sim, 5, resourceMetrics)
					}
				},
			})
		},
	})

	// World Breaker
	itemhelpers.CreateWeaponProcTrigger(itemhelpers.WeaponProcTrigger{
		ItemID:             30090,
		Name:               "World Breaker",
		PPM:                1,
		TriggerImmediately: true,
		Handler: func(character *core.Character) core.ProcHandler {
			var aura *core.Aura
			aura = character.RegisterAura(core.Aura{
				Label:     "World Breaker",
				ActionID:  core.ActionID{SpellID: 36111},
				Duration:  time.Second * 4,
				MaxStacks: 2,
			}).
				AttachStatBuff(stats.MeleeCritRating, 900).
				AttachProcTrigger(core.ProcTrigger{
					Name:     "World Breaker - Consume",
					ProcMask: core.ProcMaskMelee,
					Callback: core.CallbackOnSpellHitDealt,
					// TriggerImmediately ommited: World Breaker aura lingers affecting all spells
					// in the batch similar to Windfury
					Handler: func(sim *core.Simulation, _ *core.Spell, result *core.SpellResult) {
						if aura.IsActive() {
							aura.RemoveStack(sim)
						}
					},
				})

			return func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
				aura.Activate(sim)
				aura.AddStack(sim)
			}
		},
	})

	newSpeedInfusionWeaponEffect := func(itemID int32, itemName string) {
		itemhelpers.CreateWeaponProcAura(itemhelpers.WeaponProcAura{
			ItemID: itemID,
			Name:   itemName,
			PPM:    2,
			Aura: func(character *core.Character) *core.Aura {
				aura := character.RegisterAura(core.Aura{
					Label:    "Speed Infusion",
					ActionID: core.ActionID{SpellID: 36479},
					Duration: time.Second * 30,
				}).AttachMultiplyAttackSpeed(1.2)

				aura.NewActiveMovementSpeedEffect(0.5)

				return aura
			},
		})
	}

	newSpeedInfusionWeaponEffect(30311, "Warp Slicer")
	newSpeedInfusionWeaponEffect(30316, "Devastation")

	// Infinity Blade
	itemhelpers.CreateWeaponProcTrigger(itemhelpers.WeaponProcTrigger{
		ItemID: 30312,
		Name:   "Infinity Blade",
		PPM:    2,
		Handler: func(character *core.Character) core.ProcHandler {
			schools := []stats.SchoolIndex{
				stats.SchoolIndexArcane, stats.SchoolIndexFire, stats.SchoolIndexFrost,
				stats.SchoolIndexHoly, stats.SchoolIndexNature, stats.SchoolIndexShadow,
			}

			auras := character.NewEnemyAuraArray(func(target *core.Unit) *core.Aura {
				return target.GetOrRegisterAura(core.Aura{
					Label:     "Magic Disruption",
					ActionID:  core.ActionID{SpellID: 36478},
					Duration:  time.Second * 30,
					MaxStacks: 5,
					OnStacksChange: func(aura *core.Aura, sim *core.Simulation, oldStacks int32, newStacks int32) {
						for _, school := range schools {
							target.PseudoStats.SchoolDamageTakenMultiplier[school] *= (1.0 + 0.05*float64(newStacks)) / (1.0 + 0.05*float64(oldStacks))
						}
					},
				})
			})

			return func(sim *core.Simulation, _ *core.Spell, result *core.SpellResult) {
				aura := auras.Get(result.Target)
				aura.Activate(sim)
				aura.AddStack(sim)
			}
		},
	})

	// Blinkstrike
	core.NewItemEffect(31332, func(agent core.Agent) {
		character := agent.GetCharacter()
		var blinkStrikeSpell *core.Spell

		extraAttackDPM := func() *core.DynamicProcManager {
			return character.NewStaticLegacyPPMManager(
				1,
				*character.GetDynamicProcMaskForWeaponEffect(31332),
			)
		}

		dpm := extraAttackDPM()

		procTrigger := character.MakeProcTriggerAura(core.ProcTrigger{
			Name:               "Blinkstrike",
			IsWeaponProc:       true,
			DPM:                dpm,
			TriggerImmediately: true,
			Outcome:            core.OutcomeLanded,
			Callback:           core.CallbackOnSpellHitDealt,
			Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
				character.AutoAttacks.MaybeReplaceMHSwing(sim, blinkStrikeSpell).Cast(sim, result.Target)
			},
		})

		procTrigger.ApplyOnInit(func(aura *core.Aura, sim *core.Simulation) {
			config := *character.AutoAttacks.MHConfig()
			config.ActionID = config.ActionID.WithTag(31332)
			config.Flags |= core.SpellFlagPassiveSpell
			blinkStrikeSpell = character.GetOrRegisterSpell(config)
		})

		character.RegisterItemSwapCallback(core.AllMeleeWeaponSlots(), func(sim *core.Simulation, slot proto.ItemSlot) {
			dpm = extraAttackDPM()
		})

		character.ItemSwap.RegisterProc(31332, procTrigger)
	})

	// Syphon of the Nathrezim
	itemhelpers.CreateWeaponProcAura(itemhelpers.WeaponProcAura{
		ItemID: 32262,
		Name:   "Syphon of the Nathrezim",
		PPM:    1,
		Aura: func(character *core.Character) *core.Aura {
			spell := character.GetOrRegisterSpell(core.SpellConfig{
				ActionID:    core.ActionID{SpellID: 40293},
				SpellSchool: core.SpellSchoolShadow,
				ProcMask:    core.ProcMaskEmpty,
				Flags:       core.SpellFlagPassiveSpell | core.SpellFlagProc, // 40293 lacks Not a Proc.

				DamageMultiplier: 1,

				ApplyEffects: func(sim *core.Simulation, target *core.Unit, spell *core.Spell) {
					spell.CalcAndDealDamage(sim, target, 20, spell.OutcomeAlwaysHit)
				},
			})

			// 40291 is an Equip aura: ProcTypeMask 20 (melee auto and ability hits), no Can Proc From
			// Procs, no Aura Is Weapon Proc. So a plain aura proc.
			return character.MakeProcTriggerAura(core.ProcTrigger{
				Name:            "Siphon Essence",
				MetricsActionID: core.ActionID{SpellID: 40293},
				Duration:        time.Second * 6,
				ProcMask:        core.ProcMaskMelee,
				Callback:        core.CallbackOnSpellHitDealt,
				Handler: func(sim *core.Simulation, _ *core.Spell, result *core.SpellResult) {
					spell.Cast(sim, result.Target)
				},
			})
		},
	})

	// Warglaives of Azzinoth
	core.NewItemSet(core.ItemSet{
		Name: "The Twin Blades of Azzinoth",
		Bonuses: map[int32]core.ApplySetBonus{
			2: func(agent core.Agent, setBonusAura *core.Aura) {
				character := agent.GetCharacter()

				if character.Class != proto.Class_ClassRogue && character.Class != proto.Class_ClassWarrior {
					return
				}

				aura := character.NewTemporaryStatsAura(
					"The Twin Blades of Azzinoth",
					core.ActionID{SpellID: 41435},
					stats.Stats{stats.MeleeHasteRating: 450},
					time.Second*10,
				)

				hasteDPM := func() *core.DynamicProcManager {
					return character.NewStaticLegacyPPMManager(
						1,
						character.GetProcMaskForTypes(proto.WeaponType_WeaponTypeSword),
					)
				}

				dpm := hasteDPM()

				setBonusAura.
					AttachProcTrigger(core.ProcTrigger{
						Name:     "The Twin Blades of Azzinoth - Trigger",
						DPM:      dpm,
						ICD:      time.Second * 45,
						Outcome:  core.OutcomeLanded,
						Callback: core.CallbackOnSpellHitDealt,
						Handler: func(sim *core.Simulation, spell *core.Spell, result *core.SpellResult) {
							aura.Activate(sim)
						},
					}).
					ApplyOnGain(func(aura *core.Aura, sim *core.Simulation) {
						for _, at := range character.AttackTables {
							at.MobTypeBonusStats[proto.MobType_MobTypeDemon] = at.MobTypeBonusStats[proto.MobType_MobTypeDemon].Add(stats.Stats{
								stats.AttackPower:       200,
								stats.RangedAttackPower: 200,
							})
						}
					}).
					ApplyOnExpire(func(aura *core.Aura, sim *core.Simulation) {
						for _, at := range character.AttackTables {
							at.MobTypeBonusStats[proto.MobType_MobTypeDemon] = at.MobTypeBonusStats[proto.MobType_MobTypeDemon].Subtract(stats.Stats{
								stats.AttackPower:       200,
								stats.RangedAttackPower: 200,
							})
						}
					}).
					ExposeToAPL(41434)

				character.RegisterItemSwapCallback(core.AllMeleeWeaponSlots(), func(sim *core.Simulation, slot proto.ItemSlot) {
					dpm = hasteDPM()
				})
			},
		},
	})

	core.NewItemEffect(278953, func(_ core.Agent) {}) // Frostscythe of Lord Ahune - https://www.wowhead.com/tbc/spell=46643
}
