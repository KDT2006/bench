package profiler

import (
	"github.com/Microsoft/go-winio/pkg/process"
	"golang.org/x/sys/windows"
)

func getPageFaults() (int64, int64, error) {
	currentProcess := windows.CurrentProcess()

	counters, err := process.GetProcessMemoryInfo(currentProcess)
	if err != nil {
		return 0, 0, err
	}

	// consider the only count as major faults since its the only count exposed.
	return int64(counters.PageFaultCount), 0, nil
}
