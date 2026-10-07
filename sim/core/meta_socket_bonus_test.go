package core

import (
	"testing"

	"github.com/wowsims/tbc/sim/core/proto"
	"github.com/wowsims/tbc/sim/core/stats"
)

// Records the sim's rule for ticket 541 in the tbc-gear-prio repo: an empty meta socket withholds the
// socket bonus even when every coloured socket matches. ADR-0025 Decision 3 there had assumed the
// opposite. The bonus goes on Stamina, which no gem here gives, so the Stamina total is the bonus alone.
func TestEmptyMetaSocketWithMatchedColouredSocketEarnsNoBonus(t *testing.T) {
	yellowStats := stats.Stats{}
	yellowStats[stats.Agility] = gemStatValue
	metaStats := stats.Stats{}
	metaStats[stats.Strength] = gemStatValue
	bonus := stats.Stats{}
	bonus[stats.Stamina] = socketBonusStat

	yellow := Gem{ID: 2, Color: proto.GemColor_GemColorYellow, Stats: yellowStats}
	item := func(meta Gem) Item {
		return Item{
			ID:          1,
			GemSockets:  []proto.GemColor{proto.GemColor_GemColorMeta, proto.GemColor_GemColorYellow},
			Gems:        []Gem{meta, yellow},
			SocketBonus: bonus,
		}
	}

	cases := []struct {
		name string
		meta Gem
		want float64
	}{
		{"meta socket empty", Gem{}, 0},
		{"meta gem seated", Gem{ID: 3, Color: proto.GemColor_GemColorMeta, Stats: metaStats}, socketBonusStat},
		{"meta gem seated but disabled", Gem{ID: 3, Color: proto.GemColor_GemColorMeta, Stats: metaStats, Disabled: true}, socketBonusStat},
	}
	for _, c := range cases {
		if got := ItemEquipmentGemAndEnchantStats(item(c.meta))[stats.Stamina]; got != c.want {
			t.Errorf("%s, yellow socket matched: expected %v stamina from the socket bonus, got %v", c.name, c.want, got)
		}
	}
}
