package profiler

import "syscall"

func getPageFaults() (int64, int64, error) {
	usage := syscall.Rusage{}
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, 0, err
	}

	return usage.Majflt, usage.Minflt, nil
}
