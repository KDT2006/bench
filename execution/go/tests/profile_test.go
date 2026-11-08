package profiler_test

import (
	"profiler"
	"strings"
	"testing"
	"time"
)

func runProfile(t *testing.T, byteCount uint64, work func()) {
	t.Helper()
	cpuFreq := profiler.GetCPUFreqWait(20)
	if cpuFreq == 0 {
		t.Fatal("CPU timer frequency is zero")
	}

	for _, mode := range []string{"Fenced", "Unfenced"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			setups, cleanups := 0, 0
			profile := profiler.NewRepProfile(t.Name(), byteCount, func(measure func(func())) {
				setups++
				if setups != calls+1 || cleanups != calls {
					t.Fatal("setup and cleanup did not bracket the benchmark")
				}
				measure(work)
				calls++
				cleanups++
			}, 100*time.Millisecond, cpuFreq)
			result := profile.Start(mode == "Fenced")

			if calls == 0 || result.Iterations() != calls {
				t.Fatalf("iterations=%d, workload calls=%d", result.Iterations(), calls)
			}
			if setups != calls || cleanups != calls {
				t.Fatalf("setup=%d, cleanup=%d, workload calls=%d", setups, cleanups, calls)
			}
			if result.TotalTime == 0 || !(float64(result.MinTime) <= result.AvgTime && result.AvgTime <= float64(result.MaxTime)) {
				t.Fatalf("invalid timing results: %+v", result)
			}

			var output strings.Builder
			profiler.PrintResult(&output, profile, result)
			t.Log("\n" + output.String())
		})
	}
}
