package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go/format"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"profiler"
	"strings"
	"text/template"
	"time"
)

const (
	BenchTime = time.Second * 10
)

const executionTemplate = `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"profiler"
	"time"
	{{.Imports}}
)

{{.Globals}}

func main() {
	cpuFreq := profiler.GetCPUFreqWait(100)
	iteration := func(measure func(func())) {
		{{.Setup}}

		measure(func() {
			{{.Bench}}
		})

		{{.Cleanup}}
	}

	rep := profiler.NewRepProfile({{printf "%q" .Name}}, uint64({{.ByteCount}}), iteration, time.Duration({{printf "%d" .BenchDuration}}), cpuFreq)
	res := rep.Start({{.Fenced}})
	if res.Iterations() == 0 {
		fmt.Fprintln(os.Stderr, "no measurements collected")
		os.Exit(1)
	}
	payload, err := json.Marshal(map[string]any{
		"name": rep.Name,
		"byte_count": rep.ByteCount,
		"fenced": {{.Fenced}},
		"timer_frequency": rep.CPUFreq,
		"run_window_ns": int64(rep.TryForTime),
		"iterations": res.Iterations(),
		"total_page_faults": res.TotalPageFaults(),
		"measurements": res,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("\n__BENCH_RESULT__:%s\n", payload)
}
`

type ExecutionConfig struct {
	BenchDuration time.Duration // Zero uses the default BenchTime.
	Name          string
	ByteCount     int
	Fenced        bool
	Imports       string
	Globals       string
	Sweep         string
	Setup         string
	Bench         string
	Cleanup       string
}

// BenchmarkResult preserves raw profiler measurements (times are CPU ticks).
// RunWindowNS is in nanoseconds; throughput measurements are in GiB/s.
type BenchmarkResult struct {
	Name            string                            `json:"name"`
	ByteCount       uint64                            `json:"byte_count"`
	Fenced          bool                              `json:"fenced"`
	TimerFrequency  uint64                            `json:"timer_frequency"`
	RunWindowNS     int64                             `json:"run_window_ns"`
	Iterations      int                               `json:"iterations"`
	TotalPageFaults int64                             `json:"total_page_faults"`
	Measurements    profiler.RepetitionProfileResults `json:"measurements"`
	RunWindowMS     float64                           `json:"run_window_ms"`
	TimeMS          *BenchmarkTimeMS                  `json:"time_ms"`
}

// BenchmarkTimeMS contains elapsed times converted from the measured ticks.
// Total excludes setup, cleanup and profiler bookkeeping.
type BenchmarkTimeMS struct {
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	Total float64 `json:"total"`
}

func (r *BenchmarkResult) convertTimes() {
	r.RunWindowMS = float64(r.RunWindowNS) / float64(time.Millisecond)
	r.TimeMS = nil
	if r.TimerFrequency == 0 {
		return
	}
	msPerTick := 1000 / float64(r.TimerFrequency)
	r.TimeMS = &BenchmarkTimeMS{
		Min:   float64(r.Measurements.MinTime) * msPerTick,
		Max:   float64(r.Measurements.MaxTime) * msPerTick,
		Avg:   r.Measurements.AvgTime * msPerTick,
		Total: float64(r.Measurements.TotalTime) * msPerTick,
	}
}

// PrintBenchmarkResult writes a human-readable report for internal use.
func PrintBenchmarkResult(out io.Writer, result BenchmarkResult) error {
	result.convertTimes()
	var report strings.Builder
	fmt.Fprintf(&report, "--- %s ---\r\n", result.Name)
	m := result.Measurements
	fmt.Fprintf(&report, "Ticks: min=%d  max=%d  avg=%.2f\r\n",
		m.MinTime, m.MaxTime, m.AvgTime)
	if result.TimeMS != nil {
		t := result.TimeMS
		fmt.Fprintf(&report, "Time (ms): min=%.9f  max=%.9f  avg=%.9f\r\n",
			t.Min, t.Max, t.Avg)
	} else {
		fmt.Fprint(&report, "Time (ms): unavailable\r\n")
	}
	if result.ByteCount > 0 && result.TimerFrequency > 0 {
		fmt.Fprintf(&report, "Throughput (GiB/s): min=%.3f  max=%.3f  avg=%.3f\r\n",
			m.GigabytesPerSecondMax, m.GigabytesPerSecondMin, m.GigabytesPerSecondAvg)
	} else {
		fmt.Fprint(&report, "Throughput: unavailable\r\n")
	}
	fmt.Fprintf(&report, "Page faults: fastest=%d  slowest=%d  avg=%.6f\r\n",
		m.MajorPageFaultCountMin+m.MinorPageFaultCountMin,
		m.MajorPageFaultCountMax+m.MinorPageFaultCountMax, m.PageFaultCountAvg)
	fmt.Fprint(&report, "L1 data misses: unavailable\r\nBranch mispredictions: unavailable\r\n\r\n")
	_, err := io.WriteString(out, report.String())
	return err
}

// BuildExecutionSource renders a complete Go program. Compile the returned source
// within a module that resolves the profiler dependency. Sweep is ignored.
func BuildExecutionSource(cfg ExecutionConfig) (string, error) {
	if cfg.ByteCount < 0 {
		return "", fmt.Errorf("byte count must be nonnegative")
	}
	if cfg.BenchDuration < 0 {
		return "", fmt.Errorf("benchmark duration must be nonnegative")
	}
	if cfg.BenchDuration == 0 {
		cfg.BenchDuration = BenchTime
	}
	tmpl, err := template.New("execution").Option("missingkey=error").Parse(executionTemplate)
	if err != nil {
		return "", fmt.Errorf("parse execution template: %w", err)
	}
	var source bytes.Buffer
	if err := tmpl.Execute(&source, cfg); err != nil {
		return "", fmt.Errorf("render execution template: %w", err)
	}
	formatted, err := format.Source(source.Bytes())
	if err != nil {
		return "", fmt.Errorf("format execution source: %w", err)
	}
	return string(formatted), nil
}

// ParseBenchmarkResult reads stdout through EOF, ignoring benchmark log lines.
func ParseBenchmarkResult(stdout io.Reader) (BenchmarkResult, error) {
	var result BenchmarkResult
	found := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		payload, ok := strings.CutPrefix(scanner.Text(), "__BENCH_RESULT__:")
		if !ok {
			continue
		}
		if found {
			return BenchmarkResult{}, fmt.Errorf("multiple benchmark results on stdout")
		}
		if err := json.Unmarshal([]byte(payload), &result); err != nil {
			return BenchmarkResult{}, fmt.Errorf("decode benchmark result: %w", err)
		}
		found = true
	}
	if err := scanner.Err(); err != nil {
		return BenchmarkResult{}, fmt.Errorf("read benchmark stdout: %w", err)
	}
	if !found {
		return BenchmarkResult{}, fmt.Errorf("benchmark result missing from stdout")
	}
	if result.Iterations <= 0 {
		return BenchmarkResult{}, fmt.Errorf("no measurements collected")
	}
	result.convertTimes()
	return result, nil
}

// RunExecution compiles and runs a temporary executable. Call it from the Go
// execution module so go build can resolve the local profiler dependency.
func RunExecution(ctx context.Context, cfg ExecutionConfig) (BenchmarkResult, error) {
	source, err := BuildExecutionSource(cfg)
	if err != nil {
		return BenchmarkResult{}, err
	}
	dir, err := os.MkdirTemp("", "bench-execution-*")
	if err != nil {
		return BenchmarkResult{}, fmt.Errorf("create execution directory: %w", err)
	}
	defer os.RemoveAll(dir)
	sourcePath := filepath.Join(dir, "main.go")
	executablePath := filepath.Join(dir, "benchmark.exe")
	if err := os.WriteFile(sourcePath, []byte(source), 0600); err != nil {
		return BenchmarkResult{}, fmt.Errorf("write benchmark source: %w", err)
	}
	build := exec.CommandContext(ctx, "go", "build", "-o", executablePath, sourcePath)
	if output, err := build.CombinedOutput(); err != nil {
		return BenchmarkResult{}, fmt.Errorf("compile benchmark: %w\n%s", err, output)
	}
	cmd := exec.CommandContext(ctx, executablePath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return BenchmarkResult{}, fmt.Errorf("open benchmark stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return BenchmarkResult{}, fmt.Errorf("start benchmark: %w", err)
	}
	result, parseErr := ParseBenchmarkResult(stdout)
	if parseErr != nil {
		// Stop a child that may still be writing after a malformed result.
		_ = cmd.Process.Kill()
	}
	if err := cmd.Wait(); err != nil {
		return BenchmarkResult{}, fmt.Errorf("run benchmark: %w (stdout parser: %v)\n%s", err, parseErr, stderr.String())
	}
	if parseErr != nil {
		return BenchmarkResult{}, parseErr
	}
	return result, nil
}

// BuildSweepMatrix returns column names in declaration order and one row per
// combination. An empty sweep has one combination with no variable values.
func BuildSweepMatrix(sweep string) ([]string, [][]int, error) {
	variables := []string{}
	matrix := [][]int{{}}
	seen := make(map[string]bool)
	for lineNumber, line := range strings.Split(sweep, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, list, ok := strings.Cut(line, ":")
		name = strings.TrimSpace(name)
		if !ok || name == "" {
			return nil, nil, fmt.Errorf("sweep line %d: expected name: [integers]", lineNumber+1)
		}
		if seen[name] {
			return nil, nil, fmt.Errorf("sweep line %d: duplicate variable %q", lineNumber+1, name)
		}
		list = strings.TrimSpace(list)
		var values []int
		if !strings.HasPrefix(list, "[") || !strings.HasSuffix(list, "]") {
			return nil, nil, fmt.Errorf("sweep line %d: expected an integer list", lineNumber+1)
		}
		if err := json.Unmarshal([]byte(list), &values); err != nil {
			return nil, nil, fmt.Errorf("sweep line %d: invalid integer list: %w", lineNumber+1, err)
		}
		seen[name] = true
		variables = append(variables, name)
		next := [][]int{}
		for _, row := range matrix {
			for _, value := range values {
				combination := append([]int{}, row...)
				next = append(next, append(combination, value))
			}
		}
		matrix = next
	}
	return variables, matrix, nil
}

func main() {
	fileInfo, err := os.Stat("data.bin")
	if err != nil {
		log.Fatal(err)
	}

	cfg := ExecutionConfig{
		Name:      "File read",
		ByteCount: int(fileInfo.Size()),
		Fenced:    true,
		Imports:   `"io"`,
		Globals:   "var bytesRead int64",
		Sweep:     "bufferSize: [262144, 524288, 1048576]",
		Setup: `buffer := make([]byte, bufferSize)
file, err := os.Open("data.bin")
if err != nil {
	panic(err)
}`,
		Bench: `var total int64
for {
	n, err := file.Read(buffer)
	total += int64(n)
	if err == io.EOF {
		break
	}
	if err != nil {
		panic(err)
	}
}
bytesRead = total`,
		Cleanup: `if err := file.Close(); err != nil {
	panic(err)
}`,
	}

	variables, sweepMatrix, err := BuildSweepMatrix(cfg.Sweep)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(variables)
	for i, row := range sweepMatrix {
		fmt.Println(i, row)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// create different configs for each combination
	for _, row := range sweepMatrix {
		setupString := strings.Builder{}
		assignments := make([]string, len(row))

		// write a variable declration for each variable value
		for i, rowSplit := range row {
			assignments[i] = fmt.Sprintf("%s=%d", variables[i], rowSplit)
			declString := fmt.Sprintf("%s := %d\n", variables[i], rowSplit)
			setupString.WriteString(declString)
		}

		// append user setup code if there's any
		if len(cfg.Setup) != 0 {
			setupString.WriteString(fmt.Sprintf("\n%s", cfg.Setup))
		}

		name := cfg.Name
		if len(assignments) > 0 {
			name += " (" + strings.Join(assignments, ", ") + ")"
		}

		tmpCfg := ExecutionConfig{
			BenchDuration: cfg.BenchDuration,
			Name:          name,
			ByteCount:     cfg.ByteCount,
			Fenced:        cfg.Fenced,
			Imports:       cfg.Imports,
			Globals:       cfg.Globals,
			Setup:         setupString.String(),
			Bench:         cfg.Bench,
			Cleanup:       cfg.Cleanup,
		}

		result, err := RunExecution(ctx, tmpCfg)
		if err != nil {
			log.Fatal(err)
		}

		if err := PrintBenchmarkResult(os.Stdout, result); err != nil {
			log.Fatal(err)
		}

	}
}
