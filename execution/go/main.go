package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/format"
	"io"
	"log"
	"net/http"
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
	var minTimeMS, maxTimeMS, avgTimeMS float64
	if rep.CPUFreq > 0 {
		msPerTick := 1000 / float64(rep.CPUFreq)
		minTimeMS = float64(res.MinTime) * msPerTick
		maxTimeMS = float64(res.MaxTime) * msPerTick
		avgTimeMS = float64(res.TotalTime) / float64(res.Iterations()) * msPerTick
	}
	payload, err := json.Marshal(map[string]any{
		"name": rep.Name,
		"byte_count": rep.ByteCount,
		"fenced": {{.Fenced}},
		"timer_frequency": rep.CPUFreq,
		"run_window_ns": int64(rep.TryForTime),
		"iterations": res.Iterations(),
		"total_page_faults": res.TotalPageFaults(),
		"min_time_ms": minTimeMS,
		"max_time_ms": maxTimeMS,
		"avg_time_ms": avgTimeMS,
		"counter_availability": res.CounterAvailability,
		"measurements": map[string]any{
			"MinTime": res.MinTime,
			"MaxTime": res.MaxTime,
			"TotalTime": res.TotalTime,
			"MajorPageFaultCountMin": res.MajorPageFaultCountMin,
			"MinorPageFaultCountMin": res.MinorPageFaultCountMin,
			"MajorPageFaultCountMax": res.MajorPageFaultCountMax,
			"MinorPageFaultCountMax": res.MinorPageFaultCountMax,
			"L1DataMissMin": res.L1DataMissMin,
			"L1DataMissMax": res.L1DataMissMax,
			"BranchMisssMin": res.BranchMisssMin,
			"BranchMissMax": res.BranchMissMax,
		},
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

// BenchmarkResult includes raw profiler measurements (times are CPU ticks) and
// per-iteration wall-clock times converted to milliseconds using TimerFrequency.
// Millisecond fields are zero when TimerFrequency is unavailable.
// RunWindowNS is in nanoseconds.
type BenchmarkResult struct {
	CounterAvailability profiler.CounterAvailability `json:"counter_availability"`
	Name                string                       `json:"name"`
	ByteCount           uint64                       `json:"byte_count"`
	Fenced              bool                         `json:"fenced"`
	TimerFrequency      uint64                       `json:"timer_frequency"`
	RunWindowNS         int64                        `json:"run_window_ns"`
	Iterations          int                          `json:"iterations"`
	TotalPageFaults     int64                        `json:"total_page_faults"`
	MinTimeMS           float64                      `json:"min_time_ms"`
	MaxTimeMS           float64                      `json:"max_time_ms"`
	AvgTimeMS           float64                      `json:"avg_time_ms"`
	Measurements        BenchmarkMeasurements        `json:"measurements"`
}

// BenchmarkMeasurements contains raw aggregates only. Fault and hardware-counter
// Min/Max values belong to the fastest/slowest timed iterations respectively.
type BenchmarkMeasurements struct {
	MinTime   uint64
	MaxTime   uint64
	TotalTime uint64

	MajorPageFaultCountMin int64
	MinorPageFaultCountMin int64
	MajorPageFaultCountMax int64
	MinorPageFaultCountMax int64

	L1DataMissMin  int64
	L1DataMissMax  int64
	BranchMisssMin int64
	BranchMissMax  int64
}

// PrintBenchmarkResult writes a human-readable report for internal use.
func PrintBenchmarkResult(out io.Writer, result BenchmarkResult) error {
	var report strings.Builder
	fmt.Fprintf(&report, "--- %s ---\r\n", result.Name)
	m := result.Measurements
	var avgTicks, avgPageFaults float64
	if result.Iterations > 0 {
		avgTicks = float64(m.TotalTime) / float64(result.Iterations)
		avgPageFaults = float64(result.TotalPageFaults) / float64(result.Iterations)
	}
	fmt.Fprintf(&report, "Ticks: min=%d  max=%d  avg=%.2f\r\n",
		m.MinTime, m.MaxTime, avgTicks)
	if result.TimerFrequency > 0 {
		msPerTick := 1000 / float64(result.TimerFrequency)
		fmt.Fprintf(&report, "Time (ms): min=%.9f  max=%.9f  avg=%.9f\r\n",
			float64(m.MinTime)*msPerTick, float64(m.MaxTime)*msPerTick, avgTicks*msPerTick)
	} else {
		fmt.Fprint(&report, "Time (ms): unavailable\r\n")
	}
	if result.ByteCount > 0 && result.TimerFrequency > 0 && m.MinTime > 0 && m.MaxTime > 0 && avgTicks > 0 {
		throughput := func(ticks float64) float64 {
			return profiler.GBPerSec(ticks, float64(result.TimerFrequency), float64(result.ByteCount))
		}
		fmt.Fprintf(&report, "Throughput (GiB/s): min=%.3f  max=%.3f  avg=%.3f\r\n",
			throughput(float64(m.MaxTime)), throughput(float64(m.MinTime)), throughput(avgTicks))
	} else {
		fmt.Fprint(&report, "Throughput: unavailable\r\n")
	}
	fmt.Fprintf(&report, "Page faults: fastest=%d  slowest=%d  avg=%.6f\r\n",
		m.MajorPageFaultCountMin+m.MinorPageFaultCountMin,
		m.MajorPageFaultCountMax+m.MinorPageFaultCountMax, avgPageFaults)
	if result.CounterAvailability.L1DataMisses {
		fmt.Fprintf(&report, "L1 data-cache misses: fastest=%d  slowest=%d\r\n", m.L1DataMissMin, m.L1DataMissMax)
	} else {
		fmt.Fprint(&report, "L1 data-cache misses: unavailable\r\n")
	}
	if result.CounterAvailability.BranchMisses {
		fmt.Fprintf(&report, "Branch-prediction misses: fastest=%d  slowest=%d\r\n", m.BranchMisssMin, m.BranchMissMax)
	} else {
		fmt.Fprint(&report, "Branch-prediction misses: unavailable\r\n")
	}
	fmt.Fprint(&report, "\r\n")
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

// ExecutionRequest is the JSON payload accepted by POST /execute.
type ExecutionRequest struct {
	Name      string `json:"name"`
	ByteCount int    `json:"byteCount"`
	Fenced    bool   `json:"fenced"`
	Code      string `json:"code"`
}

// ParseExecutionConfig separates directive blocks without changing their Go code.
func ParseExecutionConfig(request ExecutionRequest) (ExecutionConfig, error) {
	cfg := ExecutionConfig{
		Name: request.Name, ByteCount: request.ByteCount, Fenced: request.Fenced,
	}
	if strings.TrimSpace(request.Name) == "" {
		return ExecutionConfig{}, fmt.Errorf("name is required")
	}
	if request.ByteCount < 0 {
		return ExecutionConfig{}, fmt.Errorf("byteCount must be nonnegative")
	}
	blocks := map[string]*string{
		"#imports": &cfg.Imports,
		"#globals": &cfg.Globals,
		"#sweep":   &cfg.Sweep,
		"#setup":   &cfg.Setup,
		"#bench":   &cfg.Bench,
		"#cleanup": &cfg.Cleanup,
	}
	seen := make(map[string]bool)
	var current *string
	var body strings.Builder
	for i, line := range strings.Split(strings.ReplaceAll(request.Code, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			block, ok := blocks[trimmed]
			if !ok {
				return ExecutionConfig{}, fmt.Errorf("line %d: unknown directive %q", i+1, trimmed)
			}
			if seen[trimmed] {
				return ExecutionConfig{}, fmt.Errorf("line %d: duplicate directive %s", i+1, trimmed)
			}
			seen[trimmed] = true
			if current != nil {
				*current = body.String()
				body.Reset()
			}
			current = block
			continue
		}
		if current == nil {
			if trimmed != "" {
				return ExecutionConfig{}, fmt.Errorf("line %d: code must follow a directive", i+1)
			}
			continue
		}
		body.WriteString(line)
		body.WriteByte('\n')
	}
	if current != nil {
		*current = body.String()
	}
	if !seen["#bench"] {
		return ExecutionConfig{}, fmt.Errorf("#bench directive is required")
	}
	return cfg, nil
}

// RunSweep executes each combination with its own timeout and returns JSON-ready results.
func RunSweep(ctx context.Context, cfg ExecutionConfig) ([]BenchmarkResult, error) {
	variables, matrix, err := BuildSweepMatrix(cfg.Sweep)
	if err != nil {
		return nil, err
	}
	results := make([]BenchmarkResult, 0, len(matrix))
	for _, row := range matrix {
		var setup strings.Builder
		assignments := make([]string, len(row))
		for i, value := range row {
			assignments[i] = fmt.Sprintf("%s=%d", variables[i], value)
			fmt.Fprintf(&setup, "%s := %d\n_ = %s\n", variables[i], value, variables[i])
		}
		setup.WriteString(cfg.Setup)
		runCfg := cfg
		runCfg.Setup = setup.String()
		if len(assignments) > 0 {
			runCfg.Name += " (" + strings.Join(assignments, ", ") + ")"
		}
		runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		result, err := RunExecution(runCtx, runCfg)
		contextErr := runCtx.Err()
		cancel()
		if contextErr != nil {
			return nil, fmt.Errorf("%s: %w", runCfg.Name, contextErr)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", runCfg.Name, err)
		}
		results = append(results, result)
	}
	return results, nil
}

func handleExecution(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	defer r.Body.Close()
	var request ExecutionRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "body must contain one JSON object", http.StatusBadRequest)
		return
	}
	cfg, err := ParseExecutionConfig(request)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, _, err := BuildSweepMatrix(cfg.Sweep); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	results, err := RunSweep(r.Context(), cfg)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(struct {
		Results []BenchmarkResult `json:"results"`
	}{Results: results}); err != nil {
		log.Printf("write execution response: %v", err)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/execute", handleExecution)
	server := &http.Server{
		Addr:              "127.0.0.1:6969",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("Go execution server listening on http://%s", server.Addr)
	log.Fatal(server.ListenAndServe())
}
