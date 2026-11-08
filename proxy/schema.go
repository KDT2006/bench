package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// localResponse is what the local Go server returns from POST /execute: one result per sweep
// combination. Its results match execution/go's BenchmarkResult JSON.
type localResponse struct {
	Results *[]localResult `json:"results"`
}

// CounterAvailability distinguishes measured zero counts from unavailable events.
type CounterAvailability struct {
	L1DataMisses bool `json:"l1DataMisses"`
	BranchMisses bool `json:"branchMisses"`
}

// localResult contains raw measurements plus per-iteration milliseconds converted
// by the execution server using TimerFrequency. RunWindowNS is nanoseconds.
type localResult struct {
	CounterAvailability CounterAvailability `json:"counter_availability"`
	Name                string              `json:"name"`
	ByteCount           uint64              `json:"byte_count"`
	Fenced              bool                `json:"fenced"`
	TimerFrequency      uint64              `json:"timer_frequency"`
	RunWindowNS         int64               `json:"run_window_ns"`
	Iterations          int                 `json:"iterations"`
	TotalPageFaults     int64               `json:"total_page_faults"`
	MinTimeMS           float64             `json:"min_time_ms"`
	MaxTimeMS           float64             `json:"max_time_ms"`
	AvgTimeMS           float64             `json:"avg_time_ms"`
	Measurements        localMeasurements   `json:"measurements"`
}

// localMeasurements matches execution/go's BenchmarkMeasurements. Times are CPU
// timer ticks; fault and counter Min/Max values belong to the fastest/slowest
// timed iterations. Derived averages and throughput are not returned here.
type localMeasurements struct {
	MinTime   uint64 `json:"MinTime"`
	MaxTime   uint64 `json:"MaxTime"`
	TotalTime uint64 `json:"TotalTime"`

	MajorPageFaultCountMin int64 `json:"MajorPageFaultCountMin"`
	MinorPageFaultCountMin int64 `json:"MinorPageFaultCountMin"`
	MajorPageFaultCountMax int64 `json:"MajorPageFaultCountMax"`
	MinorPageFaultCountMax int64 `json:"MinorPageFaultCountMax"`

	L1DataMissMin  int64 `json:"L1DataMissMin"`
	L1DataMissMax  int64 `json:"L1DataMissMax"`
	BranchMisssMin int64 `json:"BranchMisssMin"` // Spelling matches the profiler's wire format.
	BranchMissMax  int64 `json:"BranchMissMax"`
}

// ExecuteResponse is what the proxy returns to the website.
type ExecuteResponse struct {
	Results []Result `json:"results"`
}

// Result is one benchmark run as the website reads it.
type Result struct {
	CounterAvailability CounterAvailability `json:"counterAvailability"`
	Name                string              `json:"name"`
	ByteCount           uint64              `json:"byteCount"`
	Fenced              bool                `json:"fenced"`
	TimerFrequency      uint64              `json:"timerFrequency"` // ticks per second
	RunWindowNanos      int64               `json:"runWindowNanos"`
	RunWindowMillis     int64               `json:"runWindowMillis"`
	Iterations          int                 `json:"iterations"`
	TotalPageFaults     int64               `json:"totalPageFaults"`
	Measurements        Measurements        `json:"measurements"`
	TimeMs              TimeMs              `json:"timeMs"`
}

// Measurements is the website schema, including proxy-computed averages and
// throughput alongside raw profiler fields. Times are ticks. Min/Max page-fault, L1 and
// branch values belong to the fastest/slowest iteration. GigabytesPerSecondMin is computed from
// MinTime (the fastest iteration), matching the profiler. Throughput is zero when byteCount or
// timerFrequency is zero.
type Measurements struct {
	NumIterations   int   `json:"numIterations"`
	TotalPageFaults int64 `json:"totalPageFaults"`

	MinTime   uint64
	MaxTime   uint64
	TotalTime uint64
	AvgTime   float64

	GigabytesPerSecondMin float64
	GigabytesPerSecondMax float64
	GigabytesPerSecondAvg float64

	MajorPageFaultCountMin int64
	MinorPageFaultCountMin int64
	MajorPageFaultCountMax int64
	MinorPageFaultCountMax int64
	PageFaultCountAvg      float64

	L1DataMissMin int64
	L1DataMissMax int64

	BranchMisssMin int64
	BranchMissMax  int64
}

// TimeMs is per-iteration wall time in milliseconds; Total covers all iterations.
// All zero when timerFrequency is zero.
type TimeMs struct {
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	Total float64 `json:"total"`
}

func convertResponse(data []byte) (ExecuteResponse, error) {
	var local localResponse
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&local); err != nil {
		return ExecuteResponse{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if local.Results == nil {
		return ExecuteResponse{}, errors.New(`missing "results"`)
	}
	out := ExecuteResponse{Results: make([]Result, 0, len(*local.Results))}
	for _, r := range *local.Results {
		out.Results = append(out.Results, convertResult(r))
	}
	return out, nil
}

func convertResult(r localResult) Result {
	m := r.Measurements
	res := Result{
		CounterAvailability: r.CounterAvailability,
		Name:                r.Name,
		ByteCount:           r.ByteCount,
		Fenced:              r.Fenced,
		TimerFrequency:      r.TimerFrequency,
		RunWindowNanos:      r.RunWindowNS,
		RunWindowMillis:     r.RunWindowNS / 1e6,
		Iterations:          r.Iterations,
		TotalPageFaults:     r.TotalPageFaults,
		Measurements: Measurements{
			NumIterations:          r.Iterations,
			TotalPageFaults:        r.TotalPageFaults,
			MinTime:                m.MinTime,
			MaxTime:                m.MaxTime,
			TotalTime:              m.TotalTime,
			MajorPageFaultCountMin: m.MajorPageFaultCountMin,
			MinorPageFaultCountMin: m.MinorPageFaultCountMin,
			MajorPageFaultCountMax: m.MajorPageFaultCountMax,
			MinorPageFaultCountMax: m.MinorPageFaultCountMax,
			L1DataMissMin:          m.L1DataMissMin,
			L1DataMissMax:          m.L1DataMissMax,
			BranchMisssMin:         m.BranchMisssMin,
			BranchMissMax:          m.BranchMissMax,
		},
		TimeMs: TimeMs{Min: r.MinTimeMS, Max: r.MaxTimeMS, Avg: r.AvgTimeMS},
	}
	if r.Iterations > 0 {
		res.Measurements.AvgTime = float64(m.TotalTime) / float64(r.Iterations)
		res.Measurements.PageFaultCountAvg = float64(r.TotalPageFaults) / float64(r.Iterations)
	}
	if freq := float64(r.TimerFrequency); freq > 0 {
		res.TimeMs.Total = float64(m.TotalTime) * 1000 / freq
		gbps := func(ticks float64) float64 {
			if ticks <= 0 || r.ByteCount == 0 {
				return 0
			}
			return float64(r.ByteCount) / (ticks / freq) / (1 << 30)
		}
		res.Measurements.GigabytesPerSecondMin = gbps(float64(m.MinTime))
		res.Measurements.GigabytesPerSecondMax = gbps(float64(m.MaxTime))
		res.Measurements.GigabytesPerSecondAvg = gbps(res.Measurements.AvgTime)
	}
	return res
}
