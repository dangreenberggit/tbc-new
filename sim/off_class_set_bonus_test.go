package sim

import (
	"math"
	"testing"

	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	"github.com/wowsims/tbc/sim/druid"
	"github.com/wowsims/tbc/sim/hunter"
	"github.com/wowsims/tbc/sim/rogue"
	"github.com/wowsims/tbc/sim/warrior"
	googleProto "google.golang.org/protobuf/proto"
)

// Ticket 532 (tbc-gear-prio): set pieces with no class restriction can be
// worn by another class, and a set bonus written for its own class then
// panics or changes the wearer's unrelated spells.

type offClassSpec struct {
	gearDir, gearName string
	aplDir, aplName   string
	player            func() *proto.Player
}

var (
	furyWarriorSpec = offClassSpec{"../ui/warrior/dps/gear_sets", "p1_fury", "../ui/warrior/dps/apls", "fury", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassWarrior,
			Race:          proto.Race_RaceOrc,
			TalentsString: "3500501130201-05050005505012050115",
			Spec: &proto.Player_DpsWarrior{DpsWarrior: &proto.DpsWarrior{Options: &proto.DpsWarrior_Options{
				ClassOptions: &proto.WarriorOptions{DefaultShout: proto.WarriorShout_WarriorShoutBattle, DefaultStance: proto.WarriorStance_WarriorStanceBerserker},
			}}},
		}
	}}
	armsWarriorSpec = offClassSpec{"../ui/warrior/dps/gear_sets", "p1_arms", "../ui/warrior/dps/apls", "arms", func() *proto.Player {
		p := furyWarriorSpec.player()
		p.TalentsString = "32005011352010500221-0550000500521203"
		return p
	}}
	elementalShamanSpec = offClassSpec{"../ui/shaman/elemental/gear_sets", "p1_h", "../ui/shaman/elemental/apls", "default", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassShaman,
			Race:          proto.Race_RaceTroll,
			TalentsString: "55003105100213351051--05105301005",
			Spec: &proto.Player_ElementalShaman{ElementalShaman: &proto.ElementalShaman{Options: &proto.ElementalShaman_Options{
				ClassOptions: &proto.ShamanOptions{},
			}}},
		}
	}}
	bmHunterSpec = offClassSpec{"../ui/hunter/dps/gear_sets/phase_1/bm", "2h_6p", "../ui/hunter/dps/apls", "default", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassHunter,
			Race:          proto.Race_RaceOrc,
			TalentsString: "512002005250122431051-0505201205",
			Spec: &proto.Player_Hunter{Hunter: &proto.Hunter{Options: &proto.Hunter_Options{
				ClassOptions: &proto.HunterOptions{
					Ammo:        proto.HunterOptions_AdamantiteStinger,
					PetType:     proto.HunterOptions_Ravager,
					PetUptime:   100.0,
					QuiverBonus: proto.HunterOptions_Speed15,
				},
			}}},
		}
	}}
	retPaladinSpec = offClassSpec{"../ui/paladin/retribution/gear_sets", "p1", "../ui/paladin/retribution/apls", "default", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassPaladin,
			Race:          proto.Race_RaceBloodElf,
			TalentsString: "5-053201-0523005120033125331051",
			Spec: &proto.Player_RetributionPaladin{RetributionPaladin: &proto.RetributionPaladin{Options: &proto.RetributionPaladin_Options{
				ClassOptions: &proto.PaladinOptions{},
			}}},
		}
	}}
	feralCatSpec = offClassSpec{"../ui/druid/feralcat/gear_sets", "p1_realistic_6p", "../ui/druid/feralcat/apls", "default", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassDruid,
			Race:          proto.Race_RaceNightElf,
			TalentsString: "-503032132322105301251-05503301",
			Spec: &proto.Player_FeralCatDruid{FeralCatDruid: &proto.FeralCatDruid{
				Rotation: &proto.FeralCatDruid_Rotation{
					FinishingMove:      proto.FeralCatDruid_Rotation_Rip,
					Biteweave:          true,
					RipMinComboPoints:  5,
					BiteMinComboPoints: 5,
					MangleTrick:        true,
				},
				Options: &proto.FeralCatDruid_Options{},
			}},
		}
	}}
	swordsRogueSpec = offClassSpec{"../ui/rogue/dps/gear_sets", "p1", "../ui/rogue/dps/apls", "swords", func() *proto.Player {
		return &proto.Player{
			Class:         proto.Class_ClassRogue,
			Race:          proto.Race_RaceHuman,
			TalentsString: "00532012502-023305200005015002321151",
			Spec:          &proto.Player_Rogue{Rogue: &proto.Rogue{Options: &proto.Rogue_Options{ClassOptions: &proto.RogueOptions{}}}},
		}
	}}
)

const (
	head     = int(proto.ItemSlot_ItemSlotHead)
	shoulder = int(proto.ItemSlot_ItemSlotShoulder)
	chest    = int(proto.ItemSlot_ItemSlotChest)
	wrist    = int(proto.ItemSlot_ItemSlotWrist)
	hands    = int(proto.ItemSlot_ItemSlotHands)
	waist    = int(proto.ItemSlot_ItemSlotWaist)
	legs     = int(proto.ItemSlot_ItemSlotLegs)
	feet     = int(proto.ItemSlot_ItemSlotFeet)
)

var (
	cryptstalker2 = map[int]int32{chest: 22436, legs: 22437}
	cryptstalker8 = map[int]int32{head: 22438, shoulder: 22439, chest: 22436, wrist: 22443, hands: 22441, waist: 22442, legs: 22437, feet: 22440}
	boldArmor5    = map[int]int32{head: 28350, shoulder: 27803, chest: 28205, hands: 27475, legs: 27977}
	moonglade5    = map[int]int32{head: 28348, shoulder: 27737, chest: 28202, hands: 27468, legs: 27873}
	assassination = map[int]int32{head: 28414, shoulder: 27776, chest: 28204, hands: 27509, legs: 27908}
)

func setBonusRequest(spec offClassSpec, pieces map[int]int32) *proto.RaidSimRequest {
	player := spec.player()
	player.Rotation = core.GetAplRotation(spec.aplDir, spec.aplName).Rotation
	gear := googleProto.Clone(core.GetGearSet(spec.gearDir, spec.gearName).GearSet).(*proto.EquipmentSpec)
	for slot, id := range pieces {
		gear.Items[slot] = &proto.ItemSpec{Id: id}
	}
	player.Equipment = gear
	return &proto.RaidSimRequest{
		Raid: core.SinglePlayerRaidProto(player, nil, nil, nil),
		Encounter: &proto.Encounter{
			Duration: 180,
			Targets:  []*proto.Target{core.NewDefaultTarget()},
		},
		// IsTest stays false: only then does RunRaidSim turn a panic into
		// result.Error instead of aborting the whole test binary.
		SimOptions: &proto.SimOptions{Iterations: 10, IsTest: false, RandomSeed: 532},
	}
}

// The reference for an off-class wearer is the same sim with every bonus of
// the set replaced by a no-op: the pieces' stats stay, the bonuses do nothing.
func runWithSetBonusesDisabled(set *core.ItemSet, req *proto.RaidSimRequest) *proto.RaidSimResult {
	saved := set.Bonuses
	noop := make(map[int32]core.ApplySetBonus, len(saved))
	for n := range saved {
		noop[n] = func(core.Agent, *core.Aura) {}
	}
	set.Bonuses = noop
	defer func() { set.Bonuses = saved }()
	return core.RunRaidSim(req)
}

func TestOffClassSetBonuses(t *testing.T) {
	cases := []struct {
		name   string
		spec   offClassSpec
		set    *core.ItemSet
		pieces map[int]int32
		// ownClassDps is the wearer's DPS recorded before the class guards
		// existed. Zero marks an off-class wearer.
		ownClassDps float64
	}{
		{"cryptstalker-2pc-warrior", furyWarriorSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker2, 0},
		{"cryptstalker-8pc-warrior", furyWarriorSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker8, 0},
		{"cryptstalker-2pc-shaman", elementalShamanSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker2, 0},
		{"cryptstalker-8pc-shaman", elementalShamanSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker8, 0},
		{"cryptstalker-2pc-hunter", bmHunterSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker2, 789.706224},
		{"cryptstalker-8pc-hunter", bmHunterSpec, hunter.ItemSetCryptstalkerArmor, cryptstalker8, 774.907778},

		{"bold-5pc-paladin", retPaladinSpec, warrior.ItemSetBoldArmor, boldArmor5, 0},
		{"bold-5pc-warrior", furyWarriorSpec, warrior.ItemSetBoldArmor, boldArmor5, 450.971957},

		{"moonglade-5pc-warrior", armsWarriorSpec, druid.ItemSetMoongladeRaiment, moonglade5, 0},
		{"moonglade-5pc-druid", feralCatSpec, druid.ItemSetMoongladeRaiment, moonglade5, 685.414701},

		{"assassination-5pc-hunter", bmHunterSpec, rogue.Dungeon3, assassination, 0},
		{"assassination-5pc-rogue", swordsRogueSpec, rogue.Dungeon3, assassination, 553.359163},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result := core.RunRaidSim(setBonusRequest(c.spec, c.pieces))
			if result.Error != nil {
				t.Fatalf("sim error: %s", firstLines(result.Error.Message, 12))
			}
			dps := result.RaidMetrics.Dps.Avg
			t.Logf("dps %.6f", dps)

			want := c.ownClassDps
			if want == 0 {
				reference := runWithSetBonusesDisabled(c.set, setBonusRequest(c.spec, c.pieces))
				if reference.Error != nil {
					t.Fatalf("reference sim error: %s", firstLines(reference.Error.Message, 12))
				}
				want = reference.RaidMetrics.Dps.Avg
			}
			if math.Abs(dps-want) > 0.001 {
				t.Errorf("dps %.6f, want %.6f", dps, want)
			}
		})
	}
}

func firstLines(s string, n int) string {
	lines := 0
	for i, r := range s {
		if r == '\n' {
			lines++
			if lines == n {
				return s[:i]
			}
		}
	}
	return s
}
