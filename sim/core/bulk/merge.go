package bulk

import (
	"log"
	"math"

	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	googleProto "google.golang.org/protobuf/proto"
)

func mergeBulkSimCandidateResults(result *BulkSimCandidateResult, additionalResult *BulkSimCandidateResult) *BulkSimCandidateResult {
	// Nothing carried over: the additional run is the whole result.
	if result == nil {
		return additionalResult
	}
	if result.Error != nil {
		return result
	}
	if additionalResult == nil || additionalResult.Error != nil {
		return additionalResult
	}

	return &BulkSimCandidateResult{
		Candidate:  result.Candidate,
		DpsMetrics: mergeBulkSimDistributionMetrics(result.DpsMetrics, additionalResult.DpsMetrics),
	}
}

// Combines metrics from two independent sim runs for the same gear set.
// AggregatorData carries the sample count and sum of squares needed to
// recompute the weighted mean/stdev after adaptive extra iterations are
// appended.
func mergeBulkSimDistributionMetrics(metrics *proto.DistributionMetrics, additionalMetrics *proto.DistributionMetrics) *proto.DistributionMetrics {
	if metrics == nil {
		return additionalMetrics
	}
	if additionalMetrics == nil {
		return metrics
	}

	metricsAggregator := bulkSimDistributionMetricsAggregatorData(metrics)
	additionalAggregator := bulkSimDistributionMetricsAggregatorData(additionalMetrics)
	totalN := metricsAggregator.N + additionalAggregator.N
	if totalN <= 0 {
		return googleProto.Clone(metrics).(*proto.DistributionMetrics)
	}

	combinedMetrics := &proto.DistributionMetrics{
		Min:            math.MaxFloat64,
		MinSeed:        math.MaxInt64,
		Hist:           make(map[int32]int32),
		AllValues:      make([]float64, 0),
		AggregatorData: &proto.AggregatorData{},
	}
	core.CombineDistributionMetrics(combinedMetrics, metrics, false, float64(metricsAggregator.N)/float64(totalN))
	core.CombineDistributionMetrics(combinedMetrics, additionalMetrics, true, float64(additionalAggregator.N)/float64(totalN))
	return combinedMetrics
}

func bulkSimDistributionMetricsAggregatorData(metrics *proto.DistributionMetrics) *proto.AggregatorData {
	if metrics.AggregatorData != nil && metrics.AggregatorData.N > 0 {
		return metrics.AggregatorData
	}
	// Fabricating N=1 makes a merge silently mis-weight the two runs, so surface it
	// instead of letting a wrong average through unnoticed.
	log.Printf("[Bulk Sim] WARNING: distribution metrics are missing aggregator data; merged mean/stdev will be weighted as a single sample")
	n := int32(1)
	return &proto.AggregatorData{
		N:     n,
		SumSq: (metrics.Stdev*metrics.Stdev + metrics.Avg*metrics.Avg) * float64(n),
	}
}

// bulkSimFinalistCount returns the finalist-set size for a request. FinalistResults
// sets it apart from top_results, which also truncates the HTTP response. Zero, which
// every upstream caller sends, falls back to top_results and keeps upstream behaviour.
func bulkSimFinalistCount(request *proto.BulkSimRequest, topResults int) int {
	if request.FinalistResults <= 0 {
		return topResults
	}
	return min(int(request.FinalistResults), topResults)
}

// mergeBulkSimFinalists puts the refined finalists back onto the full result list.
// The finalist stage returns only its refined subset, but the client rejects a
// response with fewer rows than candidates, so every candidate keeps a row. A
// non-finalist keeps its earlier metrics and order.
func mergeBulkSimFinalists(results, finalists []*BulkSimCandidateResult) []*BulkSimCandidateResult {
	refined := make(map[int32]*BulkSimCandidateResult, len(finalists))
	for _, finalist := range finalists {
		if finalist != nil {
			refined[finalist.Candidate.Index] = finalist
		}
	}

	merged := make([]*BulkSimCandidateResult, 0, len(results)+len(finalists))
	seen := make(map[int32]bool, len(finalists))
	for _, result := range results {
		if result == nil {
			merged = append(merged, result)
			continue
		}
		if refinedResult, ok := refined[result.Candidate.Index]; ok {
			merged = append(merged, refinedResult)
			seen[result.Candidate.Index] = true
		} else {
			merged = append(merged, result)
		}
	}
	for _, finalist := range finalists {
		if finalist != nil && !seen[finalist.Candidate.Index] {
			merged = append(merged, finalist)
		}
	}
	return merged
}

func hasBulkSimStageError(baseline *BulkSimCandidateResult, results []*BulkSimCandidateResult) bool {
	if baseline != nil && baseline.Error != nil {
		return true
	}
	for _, result := range results {
		if result != nil && result.Error != nil {
			return true
		}
	}
	return false
}

func bulkSimResultsToCandidates(results []*BulkSimCandidateResult) []BulkSimCandidate {
	return core.MapSlice(results, func(result *BulkSimCandidateResult) BulkSimCandidate {
		return result.Candidate
	})
}

func bulkSimCandidateResultToProto(result *BulkSimCandidateResult) *proto.BulkGearResult {
	if result == nil {
		return nil
	}
	dpsMetrics := result.DpsMetrics
	if dpsMetrics != nil && len(dpsMetrics.AllValues) > 0 {
		allValues := dpsMetrics.AllValues
		dpsMetrics.AllValues = nil
		clone := googleProto.Clone(dpsMetrics).(*proto.DistributionMetrics)
		dpsMetrics.AllValues = allValues
		dpsMetrics = clone
	}
	return &proto.BulkGearResult{
		CandidateIndex: result.Candidate.Index,
		Gear:           result.Candidate.Gear,
		DpsMetrics:     dpsMetrics,
	}
}

func cleanBulkSimDpsMetrics(metrics *proto.DistributionMetrics) *proto.DistributionMetrics {
	if metrics == nil {
		return nil
	}
	// AllValues is kept: selectBulkSimSurvivors needs the per-iteration values. It is
	// stripped again in bulkSimCandidateResultToProto, so it never reaches the frontend.
	clone := googleProto.Clone(metrics).(*proto.DistributionMetrics)
	clone.Hist = nil
	return clone
}

func bulkSimAbortedError() *proto.ErrorOutcome {
	return &proto.ErrorOutcome{Type: proto.ErrorOutcomeType_ErrorOutcomeAborted, Message: "Bulk Sim Aborted"}
}
