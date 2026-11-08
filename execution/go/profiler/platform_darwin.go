package profiler

import "syscall"

// getPageFaults returns process-wide (major, minor) fault counts from
// getrusage. On macOS ru_majflt counts faults that required I/O and ru_minflt
// counts reclaims/zero-fills, matching the Python profiler's macOS behavior.
func getPageFaults() (int64, int64, error) {
	usage := syscall.Rusage{}
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, 0, err
	}

	return int64(usage.Majflt), int64(usage.Minflt), nil
}
