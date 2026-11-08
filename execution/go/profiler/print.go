package profiler

import (
	"fmt"
	"io"
)

func PrintResult(out io.Writer, profile *RepetitionProfile, result RepetitionProfileResults) {
	fmt.Fprintf(out, "--- %s ---\n", profile.Name)

	fmt.Fprintf(out, "Timer frequency: %d ticks/s\n", profile.CPUFreq)

	fmt.Fprintf(out, "Bytes/iteration: %d | Run window: %s\n", profile.ByteCount, profile.TryForTime)

	fmt.Fprintf(out, "Iterations: %d\n", result.Iterations())
	if result.Iterations() == 0 {
		fmt.Fprintln(out, "No measurements collected.")
		return
	}

	fmt.Fprintf(out, "Ticks: min=%d  max=%d  avg=%.2f  total=%d\n",
		result.MinTime, result.MaxTime, result.AvgTime, result.TotalTime)

	if profile.CPUFreq > 0 {
		microsecondsPerTick := 1e6 / float64(profile.CPUFreq)
		minTime := float64(result.MinTime) * microsecondsPerTick
		maxTime := float64(result.MaxTime) * microsecondsPerTick
		avgTime := result.AvgTime * microsecondsPerTick
		totalMilliseconds := float64(result.TotalTime) * microsecondsPerTick / 1000

		fmt.Fprintf(out, "Time: min=%.3f us  max=%.3f us  avg=%.3f us  total=%.3f ms\n",
			minTime, maxTime, avgTime, totalMilliseconds)

		fmt.Fprintf(out, "Throughput (GiB/s): fastest=%.3f  slowest=%.3f  average=%.3f\n",
			result.GigabytesPerSecondMin, result.GigabytesPerSecondMax, result.GigabytesPerSecondAvg)
	} else {
		fmt.Fprintln(out, "Time / throughput: unavailable (timer frequency is zero)")
	}

	fmt.Fprintf(out, "Page faults: total=%d  average/iteration=%.6f\n",
		result.TotalPageFaults(), result.PageFaultCountAvg)

	fmt.Fprintf(out, "  Fastest iteration: major=%d  minor=%d\n",
		result.MajorPageFaultCountMin, result.MinorPageFaultCountMin)

	fmt.Fprintf(out, "  Slowest iteration: major=%d  minor=%d\n",
		result.MajorPageFaultCountMax, result.MinorPageFaultCountMax)

	if result.CounterAvailability.L1DataMisses {
		fmt.Fprintf(out, "L1 data-cache misses: fastest=%d slowest=%d\n", result.L1DataMissMin, result.L1DataMissMax)
	} else {
		fmt.Fprintln(out, "L1 data-cache misses: unavailable")
	}
	if result.CounterAvailability.BranchMisses {
		fmt.Fprintf(out, "Branch-prediction misses: fastest=%d slowest=%d\n", result.BranchMisssMin, result.BranchMissMax)
	} else {
		fmt.Fprintln(out, "Branch-prediction misses: unavailable")
	}
}
