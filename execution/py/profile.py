"""Repetition-testing profiler (port of profile.go)."""

from __future__ import annotations

import gc
import os
import time
from dataclasses import dataclass, field
from datetime import timedelta
from contextlib import ExitStack
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
    Iteration: Callable[["Measurement"], object]
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

    # Why hardware counters could not be opened; empty when they were collected.
    HardwareCountersError: str = ""

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
    iteration: Callable[["Measurement"], object],
    tryForTime: Duration,
    cpuFreq: int,
) -> RepetitionProfile:
    """Build a profile whose iteration calls measure(work) or uses with measure.

    Setup and cleanup belong outside the measurement. Hardware counters are
    always attempted; if they cannot be opened, the run continues without them
    and the reason is recorded in HardwareCountersError.
    """
    return RepetitionProfile(
        Name=name,
        ByteCount=byteCount,
        Iteration=iteration,
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


class Measurement:
    """The timed region, usable as measure(callback) or as a context manager."""

    def __init__(self, result, fenced, counters):
        self.result = result
        self.counters = counters
        self.read_start = timer.ReadCPUTimerStartFenced if fenced else timer.ReadCPUTimer
        self.read_end = timer.ReadCPUTimerEndFenced if fenced else timer.ReadCPUTimer
        self.active = False
        self.calls = 0

    def __call__(self, bench: Callable[[], object]) -> None:
        with self:
            bench()

    def __enter__(self):
        if self.active or self.calls:
            raise ValueError("iteration must measure exactly once")
        self.active = True
        # Keep cyclic-GC pauses out of the timed region only; setup/cleanup run with GC on.
        self.gc_was_enabled = gc.isenabled()
        gc.disable()
        self.major_before, self.minor_before = GetPageFaultCount()
        for counter in self.counters:
            counter.Start()
        self.start = self.read_start()
        return self

    def __exit__(self, exc_type, exc, traceback):
        end = self.read_end()
        if self.gc_was_enabled:
            gc.enable()
        self.active = False
        for counter in self.counters:
            counter.Stop()
        if exc_type is not None:
            return False
        misses, branches = (c.Read() for c in self.counters) if self.counters else (0, 0)
        major_after, minor_after = GetPageFaultCount()
        elapsed = (end - self.start) & _U64
        major = major_after - self.major_before
        minor = minor_after - self.minor_before
        result = self.result
        if result._numIterations == 0 or elapsed < result.MinTime:
            result.MinTime = elapsed
            result.MajorPageFaultCountMin = major
            result.MinorPageFaultCountMin = minor
            result.L1DataMissMin = misses
            result.BranchMisssMin = branches
        if result._numIterations == 0 or elapsed > result.MaxTime:
            result.MaxTime = elapsed
            result.MajorPageFaultCountMax = major
            result.MinorPageFaultCountMax = minor
            result.L1DataMissMax = misses
            result.BranchMissMax = branches
        result.TotalTime += elapsed
        result._numIterations += 1
        result._totalPageFaults += major + minor
        self.calls += 1
        return False


def _open_counters(stack: ExitStack) -> tuple[list, str]:
    """Open both counters, or none: on failure close any opened and return why."""
    with ExitStack() as opened:
        try:
            counters = [opened.enter_context(NewCounter(event)) for event in
                        (EventL1DataMisses, EventBranchMisses)]
        except (OSError, NotImplementedError, ValueError) as exc:
            return [], str(exc) or type(exc).__name__
        stack.enter_context(opened.pop_all())
    return counters, ""


def _start(r: RepetitionProfile, fenced: bool) -> RepetitionProfileResults:
    """Repeat setup/measure/cleanup; propagate workload failures."""
    result = RepetitionProfileResults()
    with _PinnedThread(), ExitStack() as stack:
        counters, result.HardwareCountersError = _open_counters(stack)
        # The run window starts after counter setup so it isn't spent opening them.
        end_time = time.monotonic() + _to_seconds(r.TryForTime)
        measure = Measurement(result, fenced, counters)
        while time.monotonic() < end_time:
            measure.calls = 0
            r.Iteration(measure)
            if measure.calls != 1:
                raise ValueError("iteration must measure exactly once")

    if result._numIterations:
        result.AvgTime = result.TotalTime / result._numIterations
        result.PageFaultCountAvg = result._totalPageFaults / result._numIterations
        result.GigabytesPerSecondMin = GBPerSec(result.MinTime, r.CPUFreq, r.ByteCount)
        result.GigabytesPerSecondMax = GBPerSec(result.MaxTime, r.CPUFreq, r.ByteCount)
        result.GigabytesPerSecondAvg = GBPerSec(result.AvgTime, r.CPUFreq, r.ByteCount)
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
