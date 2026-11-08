package main

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Run with: go test -v -run '^TestMergeSortSweep$' -count=1 .
// Nine one-second profiling windows, plus compilation, setup and verification.
func TestMergeSortSweep(t *testing.T) {
	if testing.Short() {
		t.Skip("merge sort execution sweep")
	}
	cfg := ExecutionConfig{
		Name:          "Merge sort",
		BenchDuration: time.Second,
		Fenced:        true,
		Sweep:         "splitCount: [2, 20, 100]\narraySize: [2000, 50000, 100000]",
		Imports:       "\"math/rand\"\n\"sort\"\n\"slices\"",
		Globals: `var sortedResult []int

// mergeSort recursively sorts k roughly equal partitions, then merges them.
// This simple merge scans the partition heads for each output element.
func mergeSort(values []int, k int) []int {
	if len(values) <= 1 {
		return values
	}
	if k > len(values) {
		k = len(values)
	}
	parts := make([][]int, k)
	positions := make([]int, k)
	for i := range parts {
		start := i * len(values) / k
		end := (i + 1) * len(values) / k
		parts[i] = mergeSort(values[start:end], k)
	}
	merged := make([]int, len(values))
	for i := range merged {
		best := -1
		for p := range parts {
			if positions[p] == len(parts[p]) {
				continue
			}
			if best == -1 || parts[p][positions[p]] < parts[best][positions[best]] {
				best = p
			}
		}
		merged[i] = parts[best][positions[best]]
		positions[best]++
	}
	return merged
}`,
		Setup: `rng := rand.New(rand.NewSource(1))
values := make([]int, arraySize)
for i := range values {
	values[i] = rng.Intn(arraySize)
}
expected := slices.Clone(values)
sort.Ints(expected)`,
		Bench: `sortedResult = mergeSort(values, splitCount)`,
		Cleanup: `if !slices.Equal(sortedResult, expected) {
	panic("merge sort output differs from reference sort")
}`,
	}
	variables, matrix, err := BuildSweepMatrix(cfg.Sweep)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range matrix {
		assignments := make([]string, len(row))
		var declarations strings.Builder
		for i, value := range row {
			assignments[i] = fmt.Sprintf("%s=%d", variables[i], value)
			fmt.Fprintf(&declarations, "%s := %d\n", variables[i], value)
		}
		runCfg := cfg
		runCfg.Name += " (" + strings.Join(assignments, ", ") + ")"
		runCfg.Setup = declarations.String() + cfg.Setup
		t.Run(strings.Join(assignments, ", "), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			result, err := RunExecution(ctx, runCfg)
			if err != nil {
				t.Fatal(err)
			}
			if result.Iterations < 1 || result.RunWindowNS != int64(time.Second) {
				t.Fatalf("unexpected execution result: %+v", result)
			}
			var report bytes.Buffer
			if err := PrintBenchmarkResult(&report, result); err != nil {
				t.Fatal(err)
			}
			t.Log("\n" + report.String())
		})
	}
}
