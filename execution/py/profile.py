"""Repetition-testing profiler (port of profile.go)."""

from __future__ import annotations

import gc
import os
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Callable, Union

from . import timer
from ._pagefaults import getPageFaults
from .counter import EventBranchMisses, EventL1DataMisses, NewCounter

OSTimerFreq = 1_000_000_000

_U64 = 0xFFFF_FFFF_FFFF_FFFF

Duration = Union[timedelta, float, int]  # timedelta, or seconds


@dataclass
class RepetitionProfile:
    Name: str
    ByteCount: int
    Func: Callable[[], object]
    TryForTime: Duration
    CPUFreq: int

    def Start(self, fenced: bool) -> "RepetitionProfileResults":
        return _start(self, fenced)


@dataclass
class RepetitionProfileResults:
    _numIterations: int = field(default=0, repr=False)
    _totalPageFaults: int = field(default=0, repr=False)

    MinTime: int = 0
    MaxTime: int = 0
    TotalTime: int = 0
    AvgTime: float = 0.0

    GigabytesPerSecondMin: float = 0.0
    GigabytesPerSecondMax: float = 0.0
    GigabytesPerSecondAvg: float = 0.0

    MajorPageFaultCountMin: int = 0
    MinorPageFaultCountMin: int = 0
    MajorPageFaultCountMax: int = 0
    MinorPageFaultCountMax: int = 0
    PageFaultCountAvg: float = 0.0

    L1DataMissMin: int = 0
    L1DataMissMax: int = 0

    BranchMisssMin: int = 0  # (sic) name kept for API compatibility
    BranchMissMax: int = 0

    def Iterations(self) -> int:
        """Return the number of completed workload calls."""
        return self._numIterations

    def TotalPageFaults(self) -> int:
        """Return major and minor faults counted across all iterations."""
        return self._totalPageFaults


def ReadOSTimer() -> int:
    """OS timer in nanoseconds (monotonic)."""
    return time.perf_counter_ns()


def GetCPUFreqWait(waitTimeMs: int) -> int:
    """Return a known timer frequency, or calibrate it for waitTimeMs."""
    timerFreq = timer.ReadCPUTimerFrequency()
    if timerFreq != 0:
        return timerFreq

    CPUStart = timer.ReadCPUTimerStartFenced()
    OSStart = ReadOSTimer()
    OSEnd = 0
    OSElapsed = 0
    OSWaitTime = OSTimerFreq * waitTimeMs / 1000

    while OSElapsed < OSWaitTime:
        OSEnd = ReadOSTimer()
        OSElapsed = OSEnd - OSStart

    CPUEnd = timer.ReadCPUTimerEndFenced()
    CPUElapsed = (CPUEnd - CPUStart) & _U64
    CPUFreq = 0
    if OSElapsed > 0:
        CPUFreq = OSTimerFreq * CPUElapsed // OSElapsed

    return CPUFreq


def GetPageFaultCount() -> tuple[int, int]:
    """Return (major, minor) page faults for this process. Raises on failure."""
    return getPageFaults()


def NewRepProfile(
    name: str,
    byteCount: int,
    f: Callable[[], object],
    tryForTime: Duration,
    cpuFreq: int,
) -> RepetitionProfile:
    return RepetitionProfile(
        Name=name,
        ByteCount=byteCount,
        Func=f,
        TryForTime=tryForTime,
        CPUFreq=cpuFreq,
    )


def GBPerSec(CPUElapsed: float, CPUFreq: float, byteCount: float) -> float:
    gigabyte = 1024 * 1024 * 1024
    if CPUElapsed <= 0 or CPUFreq <= 0:
        return 0.0
    seconds = CPUElapsed / CPUFreq
    bytesPerSec = byteCount / seconds
    return bytesPerSec / gigabyte


def _to_seconds(d: Duration) -> float:
    return d.total_seconds() if isinstance(d, timedelta) else float(d)


class _PinnedThread:
    """Keep the calling thread on one core during measurement (Linux only).

    Go called runtime.LockOSThread(). A Python thread is already a single OS
    thread, so here we pin it to a CPU to stop core migration.
    """

    def __enter__(self) -> None:
        self._old = None
        if hasattr(os, "sched_setaffinity"):
            try:
                self._old = os.sched_getaffinity(0)
                os.sched_setaffinity(0, {min(self._old)})
            except OSError:
                self._old = None

    def __exit__(self, *exc: object) -> None:
        if self._old is not None:
            try:
                os.sched_setaffinity(0, self._old)
            except OSError:
                pass


class _GCDisabled:
    """Keep cyclic-GC pauses out of measured regions."""

    def __enter__(self) -> None:
        self._was_enabled = gc.isenabled()
        gc.disable()

    def __exit__(self, *exc: object) -> None:
        if self._was_enabled:
            gc.enable()


def _start(r: RepetitionProfile, fenced: bool) -> RepetitionProfileResults:
    """Measure workload calls; counter and workload failures propagate to the caller."""
    endTime = time.monotonic() + _to_seconds(r.TryForTime)

    result = RepetitionProfileResults(MinTime=_U64)

    # Look up attributes once so they aren't paid for on every iteration.
    readStart = timer.ReadCPUTimerStartFenced if fenced else timer.ReadCPUTimer
    readEnd = timer.ReadCPUTimerEndFenced if fenced else timer.ReadCPUTimer
    func = r.Func
    cpuFreq = r.CPUFreq
    byteCount = r.ByteCount

    with (
        _PinnedThread(),
        _GCDisabled(),
        NewCounter(EventL1DataMisses) as c,
        NewCounter(EventBranchMisses) as c2,
    ):
        while time.monotonic() < endTime:
            # count faults
            majorBefore, minorBefore = GetPageFaultCount()

            c.Start()
            c2.Start()

            CPUStart = readStart()
            func()
            CPUEnd = readEnd()

            c.Stop()
            misses = c.Read()
            c2.Stop()
            branchMisses = c2.Read()

            majorAfter, minorAfter = GetPageFaultCount()

            CPUElapsed = (CPUEnd - CPUStart) & _U64

            pageFaultsMajor = majorAfter - majorBefore
            pageFaultsMinor = minorAfter - minorBefore

            result.TotalTime += CPUElapsed

            if result._numIterations == 0:
                result.MinTime = CPUElapsed
                result.MaxTime = CPUElapsed
                result.GigabytesPerSecondMin = GBPerSec(CPUElapsed, cpuFreq, byteCount)
                result.GigabytesPerSecondMax = result.GigabytesPerSecondMin
                result.MajorPageFaultCountMin = pageFaultsMajor
                result.MinorPageFaultCountMin = pageFaultsMinor
                result.MajorPageFaultCountMax = pageFaultsMajor
                result.MinorPageFaultCountMax = pageFaultsMinor
                result.L1DataMissMin = result.L1DataMissMax = misses
                result.BranchMisssMin = result.BranchMissMax = branchMisses
            elif CPUElapsed < result.MinTime:
                result.MinTime = CPUElapsed
                result.GigabytesPerSecondMin = GBPerSec(result.MinTime, cpuFreq, byteCount)
                result.MajorPageFaultCountMin = pageFaultsMajor
                result.MinorPageFaultCountMin = pageFaultsMinor
                result.L1DataMissMin = misses
                result.BranchMisssMin = branchMisses
            elif CPUElapsed > result.MaxTime:
                result.MaxTime = CPUElapsed
                result.MajorPageFaultCountMax = pageFaultsMajor
                result.MinorPageFaultCountMax = pageFaultsMinor
                result.L1DataMissMax = misses
                result.BranchMissMax = branchMisses

            result._numIterations += 1
            result._totalPageFaults += pageFaultsMajor + pageFaultsMinor

    if result._numIterations == 0:
        result.MinTime = 0
        return result

    result.AvgTime = result.TotalTime / result._numIterations

    result.GigabytesPerSecondMax = GBPerSec(result.MaxTime, cpuFreq, byteCount)
    result.GigabytesPerSecondAvg = GBPerSec(result.AvgTime, cpuFreq, byteCount)

    result.PageFaultCountAvg = result._totalPageFaults / result._numIterations

    return result


__all__ = [
    "OSTimerFreq",
    "RepetitionProfile",
    "RepetitionProfileResults",
    "ReadOSTimer",
    "GetCPUFreqWait",
    "GetPageFaultCount",
    "NewRepProfile",
    "GBPerSec",
]
