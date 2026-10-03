package sim

import (
	"math"
	"os"
	"testing"

	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	googleProto "google.golang.org/protobuf/proto"
)

// Ticket 531 (tbc-gear-prio): with item swap on, these weapon effects
// rebuilt their proc manager inside an item-swap callback. That registered
// a new callback after the environment was finalized, and the sim panicked.

var enhancementShamanSpec = offClassSpec{"../ui/shaman/enhancement/gear_sets", "p1", "../ui/shaman/enhancement/apls", "default", func() *proto.Player {
	return &proto.Player{
		Class:         proto.Class_ClassShaman,
		Race:          proto.Race_RaceOrc,
		TalentsString: "03-500502210501133531151-50005301",
		Spec: &proto.Player_EnhancementShaman{EnhancementShaman: &proto.EnhancementShaman{Options: &proto.EnhancementShaman_Options{
			ImbueOh:      proto.ShamanImbue_WindfuryWeapon,
			ClassOptions: &proto.ShamanOptions{ImbueMh: proto.ShamanImbue_WindfuryWeapon},
		}}},
	}
}}

const (
	mainHand = int(proto.ItemSlot_ItemSlotMainHand)
	offHand  = int(proto.ItemSlot_ItemSlotOffHand)
)

// The Enhancement page's default swap set (sim.ts), used for Fire Elemental.
func truncheonSwap() *proto.ItemSwap {
	data, err := os.ReadFile("../ui/shaman/enhancement/gear_sets/p1.truncheon.itemswap.json")
	if err != nil {
		panic(err)
	}
	return core.ItemSwapFromJsonString(string(data))
}

// A swap set that holds only weapons. An id of 0 leaves that hand empty.
func weaponSwap(mh, oh int32) *proto.ItemSwap {
	items := make([]*proto.ItemSpec, offHand+1)
	for i := range items {
		items[i] = &proto.ItemSpec{}
	}
	items[mainHand] = &proto.ItemSpec{Id: mh}
	items[offHand] = &proto.ItemSpec{Id: oh}
	return &proto.ItemSwap{Items: items}
}

func furyWeaponSwap() *proto.ItemSwap { return weaponSwap(28438, 28729) }

func weaponSwapRequest(spec offClassSpec, mh int32, twoHand bool, swap *proto.ItemSwap) *proto.RaidSimRequest {
	player := spec.player()
	player.Rotation = core.GetAplRotation(spec.aplDir, spec.aplName).Rotation
	gear := googleProto.Clone(core.GetGearSet(spec.gearDir, spec.gearName).GearSet).(*proto.EquipmentSpec)
	gear.Items[mainHand] = &proto.ItemSpec{Id: mh}
	if twoHand {
		gear.Items[offHand] = &proto.ItemSpec{}
	}
	player.Equipment = gear
	if swap != nil {
		player.EnableItemSwap = true
		player.ItemSwap = swap
	}
	return &proto.RaidSimRequest{
		Raid: core.SinglePlayerRaidProto(player, nil, nil, nil),
		Encounter: &proto.Encounter{
			Duration: 180,
			Targets:  []*proto.Target{core.NewDefaultTarget()},
		},
		// IsTest stays false so that RunRaidSim returns a panic in
		// result.Error instead of aborting the test binary.
		SimOptions: &proto.SimOptions{Iterations: 10, IsTest: false, RandomSeed: 531},
	}
}

// procCount adds up the signs that an effect fired: aura procs on the
// player or a target, hits of an action, and events of a resource. It
// matches a metric by spell id, or by action tag when spellID is 0.
func procCount(result *proto.RaidSimResult, spellID, tag int32) float64 {
	matches := func(id *proto.ActionID) bool {
		if spellID != 0 {
			return id.GetSpellId() == spellID
		}
		return id.GetTag() == tag
	}
	player := result.RaidMetrics.Parties[0].Players[0]
	count := 0.0
	for _, aura := range player.Auras {
		if matches(aura.Id) {
			count += aura.ProcsAvg
		}
	}
	for _, target := range result.EncounterMetrics.Targets {
		for _, aura := range target.Auras {
			if matches(aura.Id) {
				count += aura.ProcsAvg
			}
		}
	}
	for _, action := range player.Actions {
		if matches(action.Id) {
			for _, target := range action.Targets {
				count += float64(target.Hits)
			}
		}
	}
	for _, resource := range player.Resources {
		if matches(resource.Id) {
			count += float64(resource.Events)
		}
	}
	return count
}

func TestWeaponProcsWithItemSwap(t *testing.T) {
	cases := []struct {
		name    string
		spec    offClassSpec
		item    int32
		twoHand bool
		swap    func() *proto.ItemSwap
		// spellID or tag finds the effect's metric for procCount.
		spellID, tag int32
		// swapOffDps is the DPS with item swap off, recorded before the fix.
		swapOffDps float64
	}{
		{"world-breaker", enhancementShamanSpec, 30090, true, truncheonSwap, 36111, 0, 694.888225},
		{"despair", enhancementShamanSpec, 28573, true, truncheonSwap, 34580, 0, 700.757428},
		{"bonereavers-edge", enhancementShamanSpec, 17076, true, truncheonSwap, 21153, 0, 600.407765},
		{"devastation", enhancementShamanSpec, 30316, true, truncheonSwap, 36479, 0, 852.737327},
		{"warp-slicer", enhancementShamanSpec, 30311, false, truncheonSwap, 36479, 0, 974.986922},
		{"infinity-blade", enhancementShamanSpec, 30312, false, truncheonSwap, 36478, 0, 886.523976},
		{"blinkstrike", enhancementShamanSpec, 31332, false, truncheonSwap, 0, 31332, 809.797248},
		// Rod's effect returns early without an energy or rage bar, so a
		// shaman never reaches the swap callback.
		{"rod-of-the-sun-king", furyWarriorSpec, 29996, false, furyWeaponSwap, 36070, 0, 633.261564},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			off := core.RunRaidSim(weaponSwapRequest(c.spec, c.item, c.twoHand, nil))
			if off.Error != nil {
				t.Fatalf("item swap off: sim error: %s", firstLines(off.Error.Message, 12))
			}
			if dps := off.RaidMetrics.Dps.Avg; math.Abs(dps-c.swapOffDps) > 0.001 {
				t.Errorf("item swap off: dps %.6f, want %.6f", dps, c.swapOffDps)
			}

			on := core.RunRaidSim(weaponSwapRequest(c.spec, c.item, c.twoHand, c.swap()))
			if on.Error != nil {
				t.Fatalf("item swap on: sim error: %s", firstLines(on.Error.Message, 26))
			}
			if procCount(on, c.spellID, c.tag) == 0 {
				t.Errorf("item swap on: the effect never fired")
			}
		})
	}
}

// A weapon that starts in the swap set must proc once the rotation swaps it
// in, so its proc manager has to follow the swap.
func TestWeaponProcSwappedIn(t *testing.T) {
	req := weaponSwapRequest(enhancementShamanSpec, 32262, false, weaponSwap(30090, 0))
	req.Raid.Parties[0].Players[0].Rotation = core.APLRotationFromJsonString(
		`{"type":"TypeAPL","priorityList":[{"action":{"itemSwap":{"swapSet":"Swap1"}}}]}`)

	result := core.RunRaidSim(req)
	if result.Error != nil {
		t.Fatalf("sim error: %s", firstLines(result.Error.Message, 26))
	}
	if procCount(result, 36111, 0) == 0 {
		t.Errorf("World Breaker never procced after the swap")
	}
}
