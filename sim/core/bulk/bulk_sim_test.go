package bulk

import (
	"math"
	"testing"

	"github.com/wowsims/tbc/sim/core/proto"
)

func TestGetBulkSimStageMaxSurvivorsScalesLowStage(t *testing.T) {
	lowStageConfig := BulkSimStageConfig{
		Stage:        proto.BulkSimStage_BulkSimStageLow,
		MaxSurvivors: 100,
	}

	testCases := []struct {
		name           string
		candidateCount int
		want           int
	}{
		{name: "below reference", candidateCount: 863, want: 100},
		{name: "at reference", candidateCount: 1000, want: 100},
		{name: "large candidate set", candidateCount: 13000, want: 361},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := getBulkSimStageMaxSurvivors(lowStageConfig, testCase.candidateCount); got != testCase.want {
				t.Fatalf("max survivors for %d candidates = %d, want %d", testCase.candidateCount, got, testCase.want)
			}
		})
	}
}

func TestGetBulkSimStageMaxSurvivorsScalesMediumStage(t *testing.T) {
	mediumStageConfig := BulkSimStageConfig{
		Stage:        proto.BulkSimStage_BulkSimStageMedium,
		MaxSurvivors: 25,
	}

	testCases := []struct {
		name           string
		candidateCount int
		want           int
	}{
		{name: "below reference", candidateCount: 50, want: 25},
		{name: "at reference", candidateCount: 100, want: 25},
		{name: "large low-stage output", candidateCount: 722, want: 68},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := getBulkSimStageMaxSurvivors(mediumStageConfig, testCase.candidateCount); got != testCase.want {
				t.Fatalf("max survivors for %d candidates = %d, want %d", testCase.candidateCount, got, testCase.want)
			}
		})
	}
}

func TestGetBulkSimStageMaxSurvivorsKeepsHighStageUncapped(t *testing.T) {
	highStageConfig := BulkSimStageConfig{
		Stage:        proto.BulkSimStage_BulkSimStageHigh,
		MaxSurvivors: 0,
	}

	if got := getBulkSimStageMaxSurvivors(highStageConfig, 13000); got != 0 {
		t.Fatalf("high max survivors = %d, want uncapped", got)
	}
}

func TestMergeBulkSimDistributionMetrics(t *testing.T) {
	metrics := newBulkSimTestDistributionMetrics([]float64{8, 12})
	metrics.MaxSeed = 12
	metrics.MinSeed = 8

	additionalMetrics := newBulkSimTestDistributionMetrics([]float64{16, 20, 24})
	additionalMetrics.MaxSeed = 24
	additionalMetrics.MinSeed = 16

	merged := mergeBulkSimDistributionMetrics(metrics, additionalMetrics)

	assertFloatEqual(t, "avg", merged.Avg, 16)
	assertFloatEqual(t, "stdev", merged.Stdev, math.Sqrt(32))
	if merged.AggregatorData.N != 5 {
		t.Fatalf("expected 5 merged samples, got %d", merged.AggregatorData.N)
	}
	assertFloatEqual(t, "sumSq", merged.AggregatorData.SumSq, 1440)
	assertFloatEqual(t, "max", merged.Max, 24)
	assertFloatEqual(t, "min", merged.Min, 8)
	if merged.MaxSeed != 24 {
		t.Fatalf("expected max seed 24, got %d", merged.MaxSeed)
	}
	if merged.MinSeed != 8 {
		t.Fatalf("expected min seed 8, got %d", merged.MinSeed)
	}
}

func newBulkSimTestDistributionMetrics(values []float64) *proto.DistributionMetrics {
	metrics := &proto.DistributionMetrics{
		Min:            math.MaxFloat64,
		AggregatorData: &proto.AggregatorData{N: int32(len(values))},
	}
	for idx, value := range values {
		metrics.Avg += value
		metrics.AggregatorData.SumSq += value * value
		if value > metrics.Max {
			metrics.Max = value
			metrics.MaxSeed = int64(value)
		}
		if value < metrics.Min {
			metrics.Min = value
			metrics.MinSeed = int64(value)
		}
		if idx == len(values)-1 {
			metrics.Avg /= float64(len(values))
		}
	}
	metrics.Stdev = math.Sqrt(metrics.AggregatorData.SumSq/float64(len(values)) - metrics.Avg*metrics.Avg)
	return metrics
}

func assertFloatEqual(t *testing.T, name string, actual float64, expected float64) {
	t.Helper()
	if math.Abs(actual-expected) > 1e-9 {
		t.Fatalf("expected %s %.12f, got %.12f", name, expected, actual)
	}
}

func TestBulkSimFinalistCount(t *testing.T) {
	testCases := []struct {
		name            string
		finalistResults int32
		topResults      int
		want            int
	}{
		{name: "zero falls back to topResults", finalistResults: 0, topResults: 25, want: 25},
		{name: "smaller than topResults kept", finalistResults: 5, topResults: 25, want: 5},
		{name: "larger than topResults clamped", finalistResults: 30, topResults: 25, want: 25},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			request := &proto.BulkSimRequest{FinalistResults: testCase.finalistResults}
			if got := bulkSimFinalistCount(request, testCase.topResults); got != testCase.want {
				t.Fatalf("finalist count for FinalistResults=%d topResults=%d = %d, want %d",
					testCase.finalistResults, testCase.topResults, got, testCase.want)
			}
		})
	}
}

func TestMergeBulkSimFinalists(t *testing.T) {
	// 25 pre-stage results, each carrying its index as its Avg so a refined overlay is detectable.
	results := make([]*BulkSimCandidateResult, 0, 25)
	for i := int32(0); i < 25; i++ {
		results = append(results, &BulkSimCandidateResult{
			Candidate:  BulkSimCandidate{Index: i},
			DpsMetrics: newBulkSimTestDistributionMetrics([]float64{float64(i)}),
		})
	}

	// 5 refined finalists (indices 0..4) with a distinct Avg and a longer AllValues than the
	// originals, standing in for the extra lockstep iterations the stage adds.
	finalists := make([]*BulkSimCandidateResult, 0, 5)
	for i := int32(0); i < 5; i++ {
		refined := &proto.DistributionMetrics{
			Avg:            1000 + float64(i),
			AllValues:      []float64{1, 2, 3, 4},
			AggregatorData: &proto.AggregatorData{N: 4},
		}
		finalists = append(finalists, &BulkSimCandidateResult{
			Candidate:  BulkSimCandidate{Index: i},
			DpsMetrics: refined,
		})
	}

	merged := mergeBulkSimFinalists(results, finalists)

	if len(merged) != 25 {
		t.Fatalf("expected 25 merged results, got %d", len(merged))
	}
	for i, result := range merged {
		if result.Candidate.Index != int32(i) {
			t.Fatalf("result %d has index %d, want %d (order not preserved)", i, result.Candidate.Index, i)
		}
		if i < 5 {
			if got := result.DpsMetrics.Avg; got != 1000+float64(i) {
				t.Fatalf("finalist %d Avg = %v, want refined %v", i, got, 1000+float64(i))
			}
			if got := len(result.DpsMetrics.AllValues); got != 4 {
				t.Fatalf("finalist %d AllValues len = %d, want refined 4", i, got)
			}
		} else {
			if got := result.DpsMetrics.Avg; got != float64(i) {
				t.Fatalf("non-finalist %d Avg = %v, want original %v", i, got, float64(i))
			}
		}
	}
}
