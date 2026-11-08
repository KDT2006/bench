package profiler

import (
	"log"
	"math"
	"runtime"
	"time"
)

const OSTimerFreq = 1_000_000_000

type RepetitionProfile struct {
	Name      string
	ByteCount uint64
	// Iteration wraps each measurement with setup and cleanup.
	// It must call measure exactly once with the benchmark function.
	Iteration  func(measure func(func()))
	TryForTime time.Duration
	CPUFreq    uint64
}

type RepetitionProfileResults struct {
	CounterAvailability CounterAvailability

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

// Iterations returns the number of completed workload calls.
func (r RepetitionProfileResults) Iterations() int { return r.numIterations }

// TotalPageFaults returns the major and minor faults counted across all iterations.
func (r RepetitionProfileResults) TotalPageFaults() int64 { return r.totalPageFaults }

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

func GetCPUFreqWait(waitTimeMs uint64) uint64 {
	if timerFreq := ReadCPUTimerFrequency(); timerFreq != 0 {
		return timerFreq
	}

	CPUStart := ReadCPUTimerStartFenced()
	OSStart := ReadOSTimer()
	var OSEnd uint64
	var OSElapsed uint64
	OSWaitTime := OSTimerFreq * float64(waitTimeMs) / 1000

	for OSElapsed < uint64(OSWaitTime) {
		OSEnd = ReadOSTimer()
		OSElapsed = OSEnd - OSStart
	}

	CPUEnd := ReadCPUTimerEndFenced()
	CPUElapsed := CPUEnd - CPUStart
	var CPUFreq uint64
	if OSElapsed > 0 {
		CPUFreq = OSTimerFreq * CPUElapsed / OSElapsed
	}

	return CPUFreq
}

func GetPageFaultCount() (int64, int64, error) {
	return getPageFaults()
}

func NewRepProfile(name string, byteCount uint64, iteration func(measure func(func())), tryForTime time.Duration, cpuFreq uint64) *RepetitionProfile {
	return &RepetitionProfile{
		Name:       name,
		ByteCount:  byteCount,
		Iteration:  iteration,
		TryForTime: tryForTime,
		CPUFreq:    cpuFreq,
	}
}

func (r *RepetitionProfile) Start(fenced bool) RepetitionProfileResults {
	endTime := time.Now().Add(r.TryForTime)

	// Keep thread-scoped perf counters on the thread running the measured work.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	result := RepetitionProfileResults{
		MinTime: math.MaxUint64,
	}

	l1Counter := openOptionalCounter(EventL1DataMisses)
	branchCounter := openOptionalCounter(EventBranchMisses)
	defer l1Counter.close()
	defer branchCounter.close()

	measure := func(bench func()) {
		// count faults
		majorBefore, minorBefore, err := GetPageFaultCount()
		if err != nil {
			log.Fatal(err)
		}

		l1Counter.start()
		branchCounter.start()

		var CPUStart uint64
		var CPUEnd uint64

		if fenced {
			CPUStart = ReadCPUTimerStartFenced()
		} else {
			CPUStart = ReadCPUTimer()
		}

		bench()

		if fenced {
			CPUEnd = ReadCPUTimerEndFenced()
		} else {
			CPUEnd = ReadCPUTimer()
		}

		misses := l1Counter.stopRead()
		branchMisses := branchCounter.stopRead()

		majorAfter, minorAfter, err := GetPageFaultCount()
		if err != nil {
			log.Fatal(err)
		}

		CPUElapsed := CPUEnd - CPUStart

		pageFaultsMajor := majorAfter - majorBefore
		pageFaultsMinor := minorAfter - minorBefore

		result.TotalTime += CPUElapsed

		if result.numIterations == 0 {
			result.MinTime = CPUElapsed
			result.MaxTime = CPUElapsed
			result.GigabytesPerSecondMin = GBPerSec(float64(CPUElapsed), float64(r.CPUFreq), float64(r.ByteCount))
			result.GigabytesPerSecondMax = result.GigabytesPerSecondMin

			result.MajorPageFaultCountMin = pageFaultsMajor
			result.MinorPageFaultCountMin = pageFaultsMinor
			result.MajorPageFaultCountMax = pageFaultsMajor
			result.MinorPageFaultCountMax = pageFaultsMinor
			result.L1DataMissMin, result.L1DataMissMax = misses, misses
			result.BranchMisssMin, result.BranchMissMax = branchMisses, branchMisses
		} else if CPUElapsed < result.MinTime {
			result.MinTime = CPUElapsed
			result.GigabytesPerSecondMin = GBPerSec(float64(result.MinTime), float64(r.CPUFreq), float64(r.ByteCount))
			result.MajorPageFaultCountMin = pageFaultsMajor
			result.MinorPageFaultCountMin = pageFaultsMinor
			result.L1DataMissMin = misses
			result.BranchMisssMin = branchMisses
		} else if CPUElapsed > result.MaxTime {
			result.MaxTime = CPUElapsed
			result.MajorPageFaultCountMax = pageFaultsMajor
			result.MinorPageFaultCountMax = pageFaultsMinor
			result.L1DataMissMax = misses
			result.BranchMissMax = branchMisses
		}

		result.numIterations++
		result.totalPageFaults += pageFaultsMajor + pageFaultsMinor
	}

	for time.Now().Compare(endTime) == -1 {
		r.Iteration(measure)
	}

	l1Counter.close()
	branchCounter.close()
	result.CounterAvailability = CounterAvailability{L1DataMisses: l1Counter.available, BranchMisses: branchCounter.available}
	if !l1Counter.available {
		result.L1DataMissMin, result.L1DataMissMax = 0, 0
	}
	if !branchCounter.available {
		result.BranchMisssMin, result.BranchMissMax = 0, 0
	}

	result.AvgTime = float64(result.TotalTime) / float64(result.numIterations)

	result.GigabytesPerSecondMin = GBPerSec(float64(result.MinTime), float64(r.CPUFreq), float64(r.ByteCount))
	result.GigabytesPerSecondMax = GBPerSec(float64(result.MaxTime), float64(r.CPUFreq), float64(r.ByteCount))
	result.GigabytesPerSecondAvg = GBPerSec(result.AvgTime, float64(r.CPUFreq), float64(r.ByteCount))

	result.PageFaultCountAvg = float64(result.totalPageFaults) / float64(result.numIterations)

	return result
}

func GBPerSec(CPUElapsed, CPUFreq, byteCount float64) float64 {
	megabyte := 1024 * 1024
	gigabyte := megabyte * 1024
	seconds := CPUElapsed / CPUFreq
	bytesPerSec := byteCount / seconds
	return bytesPerSec / float64(gigabyte)
}
