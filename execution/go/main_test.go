package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"profiler"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildSweepMatrix(t *testing.T) {
	for _, tc := range []struct {
		name, sweep string
		variables   []string
		matrix      [][]int
	}{
		{"two variables", "a: [10, 20]\nb: [50, 100]", []string{"a", "b"}, [][]int{{10, 50}, {10, 100}, {20, 50}, {20, 100}}},
		{"three variables", "a: [1, 2]\nb: [3]\nc: [4, 5]", []string{"a", "b", "c"}, [][]int{{1, 3, 4}, {1, 3, 5}, {2, 3, 4}, {2, 3, 5}}},
		{"whitespace", "\n a : [-1, 2] \n", []string{"a"}, [][]int{{-1}, {2}}},
		{"empty sweep", "", []string{}, [][]int{{}}},
		{"empty dimension", "a: [1]\nb: []", []string{"a", "b"}, [][]int{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			variables, matrix, err := BuildSweepMatrix(tc.sweep)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(variables, tc.variables) || !reflect.DeepEqual(matrix, tc.matrix) {
				t.Fatalf("got %v %v, want %v %v", variables, matrix, tc.variables, tc.matrix)
			}
		})
	}
	for _, sweep := range []string{"a [1]", ": [1]", "a: 1", "a: [bad]", "a: [1]\na: [2]"} {
		if _, _, err := BuildSweepMatrix(sweep); err == nil {
			t.Errorf("expected error for %q", sweep)
		}
	}
}

func TestBuildExecutionSourceCompiles(t *testing.T) {
	source, err := BuildExecutionSource(ExecutionConfig{
		Name:      "sort \"example\"\nbenchmark",
		ByteCount: 24,
		Fenced:    true,
		Imports:   `"sort"`,
		Globals:   `var sortedValues []int`,
		Setup:     `values := []int{3, 1, 2}`,
		Bench:     "sort.Ints(values)\nsortedValues = values",
		Cleanup:   `if !sort.IntsAreSorted(sortedValues) { panic("unsorted") }`,
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "build", "-o", filepath.Join(dir, "benchmark"), path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile generated source: %v\n%s", err, output)
	}
}

func TestParseBenchmarkResult(t *testing.T) {
	want := BenchmarkResult{
		Name: "addition", Iterations: 2, TimerFrequency: 1000,
		TotalPageFaults: 3,
		Measurements:    profiler.RepetitionProfileResults{MinTime: 10, MaxTime: 20, TotalTime: 30, AvgTime: 15},
	}
	want.convertTimes()
	payload, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	stdout := "user output\n__BENCH_RESULT__:" + string(payload) + "\nmore user output\n"
	got, err := ParseBenchmarkResult(strings.NewReader(stdout))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for _, stdout := range []string{
		"user output only\n",
		"__BENCH_RESULT__:{bad json}\n",
		"__BENCH_RESULT__:{}\n",
		stdout + "__BENCH_RESULT__:" + string(payload) + "\n",
	} {
		if _, err := ParseBenchmarkResult(strings.NewReader(stdout)); err == nil {
			t.Errorf("expected error for %q", stdout)
		}
	}
}

func TestBenchmarkTimeConversionAndPrinting(t *testing.T) {
	result := BenchmarkResult{
		Name: "example", TimerFrequency: 2_000_000_000, RunWindowNS: int64(10 * time.Second),
		Measurements: profiler.RepetitionProfileResults{MinTime: 40, MaxTime: 2000, AvgTime: 100, TotalTime: 2_000_000},
	}
	result.convertTimes()
	want := BenchmarkTimeMS{Min: 0.00002, Max: 0.001, Avg: 0.00005, Total: 1}
	for _, pair := range [][2]float64{
		{result.TimeMS.Min, want.Min}, {result.TimeMS.Max, want.Max},
		{result.TimeMS.Avg, want.Avg}, {result.TimeMS.Total, want.Total},
	} {
		if diff := pair[0] - pair[1]; diff < -1e-12 || diff > 1e-12 {
			t.Fatalf("converted %v, want %v", result.TimeMS, want)
		}
	}
	if result.RunWindowMS != 10_000 {
		t.Fatalf("run window = %v ms", result.RunWindowMS)
	}
	var report bytes.Buffer
	if err := PrintBenchmarkResult(&report, result); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"--- example ---", "min=0.000020000", "Throughput: unavailable"} {
		if !strings.Contains(report.String(), text) {
			t.Errorf("report missing %q: %s", text, &report)
		}
	}
	result.TimerFrequency = 0
	result.convertTimes()
	if result.TimeMS != nil {
		t.Fatal("zero frequency must leave converted times unavailable")
	}
	payload, err := json.Marshal(result)
	if err != nil || !bytes.Contains(payload, []byte(`"time_ms":null`)) {
		t.Fatalf("expected JSON null times, got %s, %v", payload, err)
	}
}

func TestRunExecutionReportsCompileError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := RunExecution(ctx, ExecutionConfig{Bench: "undefinedFunction()"})
	if err == nil || !strings.Contains(err.Error(), "undefinedFunction") {
		t.Fatalf("expected compiler diagnostic, got %v", err)
	}
}

func TestBuildExecutionSourceRejectsInvalidConfig(t *testing.T) {
	for _, cfg := range []ExecutionConfig{
		{ByteCount: -1},
		{Bench: "invalid Go code"},
	} {
		if _, err := BuildExecutionSource(cfg); err == nil {
			t.Fatalf("expected an error for %+v", cfg)
		}
	}
}
