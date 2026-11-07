package profiler

import (
	"fmt"
	"log"
	"math"
	"runtime"
	"time"
)

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

func NewRepProfile(name string, byteCount uint64, f func(), tryForTime time.Duration, cpuFreq uint64) *RepetitionProfile {
	return &RepetitionProfile{
		Name:       name,
		ByteCount:  byteCount,
		Func:       f,
		TryForTime: tryForTime,
		CPUFreq:    cpuFreq,
	}
}

func (r *RepetitionProfile) Start(fenced bool) RepetitionProfileResults {
	endTime := time.Now().Add(r.TryForTime)

	fmt.Printf("--- %s ---\n", r.Name)

	// prevent core migration
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	result := RepetitionProfileResults{
		MinTime: math.MaxUint64,
	}

	// init cache misses counter
	// c, err := NewCounter(EventL1DataMisses)
	// if err != nil {
	// 	log.Fatal(err)
	// }
	// defer c.Close()

	// init branch misses counter
	// c2, err := NewCounter(EventBranchMisses)
	// if err != nil {
	// 	log.Fatal(err)
	// }
	// defer c2.Close()

	for time.Now().Compare(endTime) == -1 {
		// count faults
		majorBefore, minorBefore, err := GetPageFaultCount()
		if err != nil {
			log.Fatal(err)
		}

		// c.Start()
		// c2.Start()

		var CPUStart uint64
		var CPUEnd uint64

		if fenced {
			CPUStart = ReadCPUTimerStartFenced()
		} else {
			CPUStart = ReadCPUTimer()
		}

		r.Func()

		if fenced {
			CPUEnd = ReadCPUTimerEndFenced()
		} else {
			CPUEnd = ReadCPUTimer()
		}

		// c.Stop()
		// misses, err := c.Read()
		// if err != nil {
		// 	log.Fatal(err)
		// }

		// c2.Stop()
		// branchMisses, err := c2.Read()
		// if err != nil {
		// 	log.Fatal(err)
		// }

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
		} else if CPUElapsed < result.MinTime {
			result.MinTime = CPUElapsed
			result.GigabytesPerSecondMin = GBPerSec(float64(result.MinTime), float64(r.CPUFreq), float64(r.ByteCount))
			result.MajorPageFaultCountMin = pageFaultsMajor
			result.MinorPageFaultCountMin = pageFaultsMinor
			// r.L1DataMissMin = misses
			// r.BranchMisssMin = branchMisses
		} else {
			result.MaxTime = CPUElapsed
			result.MajorPageFaultCountMax = pageFaultsMajor
			result.MinorPageFaultCountMax = pageFaultsMinor
			// r.L1DataMissMax = misses
			// r.BranchMissMax = branchMisses
		}

		result.numIterations++
		result.totalPageFaults += pageFaultsMajor + pageFaultsMinor
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
