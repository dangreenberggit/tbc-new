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

var enhancementShamanSpec = offClassSpec{"../ui/specs/shaman/enhancement/gear_sets", "p1", "../ui/specs/shaman/enhancement/apls", "default", func() *proto.Player {
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
	data, err := os.ReadFile("../ui/specs/shaman/enhancement/gear_sets/p1.truncheon.itemswap.json")
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
		{"world-breaker", enhancementShamanSpec, 30090, true, truncheonSwap, 36111, 0, 694.665727},
		{"despair", enhancementShamanSpec, 28573, true, truncheonSwap, 34580, 0, 679.150148},
		{"bonereavers-edge", enhancementShamanSpec, 17076, true, truncheonSwap, 21153, 0, 602.113526},
		{"devastation", enhancementShamanSpec, 30316, true, truncheonSwap, 36479, 0, 823.296484},
		{"warp-slicer", enhancementShamanSpec, 30311, false, truncheonSwap, 36479, 0, 960.968448},
		{"infinity-blade", enhancementShamanSpec, 30312, false, truncheonSwap, 36478, 0, 879.045304},
		{"blinkstrike", enhancementShamanSpec, 31332, false, truncheonSwap, 0, 31332, 819.329036},
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

// Ticket 540 (tbc-gear-prio): these effects key their proc chance on the
// type of weapon worn. Each rebuilt its proc manager into a local variable
// on item swap, but the proc trigger keeps the manager it was given at
// attach, so a weapon of the keyed type that arrives by swap never procs.
// Each test starts with no weapon of the keyed type and swaps one in.

var armsMaceWarriorSpec = offClassSpec{"../ui/specs/warrior/dps/gear_sets", "p1_arms", "../ui/specs/warrior/dps/apls", "arms", func() *proto.Player {
	p := armsWarriorSpec.player()
	// armsWarriorSpec's arms tree with its 5 points moved from Sword
	// Specialization to Mace Specialization (proto/warrior.proto fields 14, 15).
	p.TalentsString = "32005011352015000221-0550000500521203"
	return p
}}

// swapInRequest wears mh and oh (0 leaves the off hand empty) and runs a
// rotation that only swaps to Swap1.
func swapInRequest(spec offClassSpec, mh, oh int32, swap *proto.ItemSwap) *proto.RaidSimRequest {
	req := weaponSwapRequest(spec, mh, oh == 0, swap)
	player := req.Raid.Parties[0].Players[0]
	if oh != 0 {
		player.Equipment.Items[offHand] = &proto.ItemSpec{Id: oh}
	}
	player.Rotation = core.APLRotationFromJsonString(
		`{"type":"TypeAPL","priorityList":[{"action":{"itemSwap":{"swapSet":"Swap1"}}}]}`)
	return req
}

func requireSwappedInProc(t *testing.T, req *proto.RaidSimRequest, spellID, tag int32) {
	t.Helper()
	result := core.RunRaidSim(req)
	if result.Error != nil {
		t.Fatalf("sim error: %s", firstLines(result.Error.Message, 26))
	}
	if procCount(result, spellID, tag) == 0 {
		t.Errorf("the effect never procced after the swap")
	}
}

// Base: Dragonmaw (mace) and Malchazeen (dagger). Swap: two swords.
func TestItemSwapProcHandOfJustice(t *testing.T) {
	req := swapInRequest(furyWarriorSpec, 28438, 28768, weaponSwap(28295, 28189))
	req.Raid.Parties[0].Players[0].Equipment.Items[proto.ItemSlot_ItemSlotTrinket2] = &proto.ItemSpec{Id: 11815}
	requireSwappedInProc(t, req, 0, 11815)
}

// Base: Malchazeen (dagger). Swap: Lionheart Champion (two-hand sword).
func TestItemSwapProcArmsSwordSpec(t *testing.T) {
	requireSwappedInProc(t, swapInRequest(armsWarriorSpec, 28768, 0, weaponSwap(28429, 0)), 0, 12281)
}

// Base: Malchazeen (dagger). Swap: Dragonmaw (mace). 5530 is the rage gain.
func TestItemSwapProcArmsMaceSpec(t *testing.T) {
	requireSwappedInProc(t, swapInRequest(armsMaceWarriorSpec, 28768, 0, weaponSwap(28438, 0)), 5530, 0)
}

// Base: Dragonmaw (mace) and Malchazeen (dagger). Swap: both Warglaives,
// which also activates the 2pc. 41435 is its haste aura.
func TestItemSwapProcTwinBlades(t *testing.T) {
	requireSwappedInProc(t, swapInRequest(furyWarriorSpec, 28438, 28768, weaponSwap(32837, 32838)), 41435, 0)
}

// Base: Malchazeen and Heartrazor (daggers). Swap: two swords.
func TestItemSwapProcRogueSwordSpec(t *testing.T) {
	requireSwappedInProc(t, swapInRequest(swordsRogueSpec, 28768, 29962, weaponSwap(28295, 28189)), 0, 12281)
}

// Ticket 546 (tbc-gear-prio): these PPM procs build their chance per hit
// (weapon speed × PPM / 60) from the weapons worn at the start. A proc that
// still fires at the old chance after a swap passes a count-above-zero test,
// so these tests compare procs per landed white hit with the chance of the
// weapons swapped in. The rotation swaps at the start of each iteration, so
// nearly every hit is made with the swapped-in weapons.

const (
	gladiatorsSlicer      = 28295 // main-hand sword, speed 2.6
	nexusStalkerScimitar  = 25952 // main-hand sword, speed 1.5
	gladiatorsQuickblade  = 28307 // off-hand sword, speed 1.5
	gladiatorsGreatsword  = 24550 // two-hand sword, speed 3.6
	unbridledWrathPPM     = 15    // rank 5 in furyWarriorSpec, 3 PPM per rank
	sealOfVengeancePPM    = 20
	rateRelativeTolerance = 0.10
)

func ppmChance(speed, ppm float64) float64 { return speed * ppm / 60 }

func playerActionTargets(result *proto.RaidSimResult, match func(*proto.ActionID) bool) []*proto.TargetedActionMetrics {
	var targets []*proto.TargetedActionMetrics
	for _, action := range result.RaidMetrics.Parties[0].Players[0].Actions {
		if match(action.Id) {
			targets = append(targets, action.Targets...)
		}
	}
	return targets
}

// landedWhiteHits counts the auto attacks of one hand (tag 1 main hand, tag 2
// off hand) whose outcome OutcomeLanded matches (sim/core/flags.go), the
// outcome both procs require.
func landedWhiteHits(result *proto.RaidSimResult, tag int32) float64 {
	count := int32(0)
	for _, t := range playerActionTargets(result, func(id *proto.ActionID) bool {
		return id.GetOtherId() == proto.OtherAction_OtherActionAttack && id.GetTag() == tag
	}) {
		count += t.Hits + t.Crits + t.Glances + t.Blocks + t.BlockedCrits + t.GlanceBlocks + t.Crushes
	}
	return float64(count)
}

func requireRate(t *testing.T, procs, hits, want, startChance float64) {
	t.Helper()
	rate := procs / hits
	t.Logf("procs %.0f, landed white hits %.0f, rate %.4f; swapped-in chance %.4f, start chance %.4f", procs, hits, rate, want, startChance)
	if hits == 0 {
		t.Fatalf("no landed white hits")
	}
	if math.Abs(rate-want) > rateRelativeTolerance*want {
		t.Errorf("rate %.4f is not within %.0f%% of the swapped-in chance %.4f (start chance %.4f)", rate, rateRelativeTolerance*100, want, startChance)
	}
}

func runSim(t *testing.T, req *proto.RaidSimRequest) *proto.RaidSimResult {
	t.Helper()
	result := core.RunRaidSim(req)
	if result.Error != nil {
		t.Fatalf("sim error: %s", firstLines(result.Error.Message, 26))
	}
	return result
}

// Base: a 2.6-speed main hand, no off hand. Swap: a 1.5-speed main hand.
func TestItemSwapRateUnbridledWrath(t *testing.T) {
	result := runSim(t, swapInRequest(furyWarriorSpec, gladiatorsSlicer, 0, weaponSwap(nexusStalkerScimitar, 0)))
	requireRate(t, procCount(result, 13002, 0), landedWhiteHits(result, 1),
		ppmChance(1.5, unbridledWrathPPM), ppmChance(2.6, unbridledWrathPPM))
}

// Base: a 3.6-speed two-hander, so the off hand has speed 0 when the proc is
// built and gets no proc mask (procs.go mergeOrAppend). Swap: a 2.6-speed
// main hand and a 1.5-speed off hand.
func TestItemSwapRateUnbridledWrathOffHand(t *testing.T) {
	result := runSim(t, swapInRequest(furyWarriorSpec, gladiatorsGreatsword, 0, weaponSwap(gladiatorsSlicer, gladiatorsQuickblade)))
	mh, oh := landedWhiteHits(result, 1), landedWhiteHits(result, 2)
	if oh == 0 {
		t.Fatalf("no landed off-hand white hits after the swap")
	}
	want := (mh*ppmChance(2.6, unbridledWrathPPM) + oh*ppmChance(1.5, unbridledWrathPPM)) / (mh + oh)
	t.Logf("main-hand hits %.0f, off-hand hits %.0f", mh, oh)
	requireRate(t, procCount(result, 13002, 0), mh+oh, want, ppmChance(3.6, unbridledWrathPPM)*mh/(mh+oh))
}

// Base: a 2.6-speed main hand. Swap: a 1.5-speed main hand. Both chances are
// below 1, so neither is capped. The rotation keeps the seal up; each proc
// casts Holy Vengeance (31803) once. The metrics count no casts for a passive
// spell, so a proc is a landed or missed Holy Vengeance.
func TestItemSwapRateSealOfVengeance(t *testing.T) {
	req := swapInRequest(retPaladinSpec, gladiatorsSlicer, 0, weaponSwap(nexusStalkerScimitar, 0))
	req.Raid.Parties[0].Players[0].Rotation = core.APLRotationFromJsonString(`{"type":"TypeAPL","priorityList":[
		{"action":{"itemSwap":{"swapSet":"Swap1"}}},
		{"action":{"condition":{"cmp":{"op":"OpLt","lhs":{"auraRemainingTime":{"auraId":{"spellId":31801}}},"rhs":{"const":{"val":"3s"}}}},"castSpell":{"spellId":{"spellId":31801}}}}]}`)
	result := runSim(t, req)
	procs := int32(0)
	for _, target := range playerActionTargets(result, func(id *proto.ActionID) bool { return id.GetSpellId() == 31803 }) {
		procs += target.Hits + target.Crits + target.Misses
	}
	requireRate(t, float64(procs), landedWhiteHits(result, 1),
		ppmChance(1.5, sealOfVengeancePPM), ppmChance(2.6, sealOfVengeancePPM))
}
