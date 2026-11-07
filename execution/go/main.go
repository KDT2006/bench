package profiler

import "time"

const OSTimerFreq = 1_000_000_000

type RepetitionProfile struct {
	Name       string
	ByteCount  uint64
	Func       func()
	TryForTime time.Duration
	CPUFreq    uint64
}

type RepetitionProfileResults struct {
	numIterations   int
	totalPageFaults int64

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

func ReadOSTimer() uint64 {
	return uint64(time.Now().UnixNano())
}

func ReadCPUTimer() uint64

// ReadCPUTimerFrequency returns the timer's frequency in ticks per second when
// the architecture exposes it directly. A zero result means it must be
// calibrated against the OS timer.
func ReadCPUTimerFrequency() uint64

// fenced impls
func ReadCPUTimerStartFenced() uint64
func ReadCPUTimerEndFenced() uint64
