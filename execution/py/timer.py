"""CPU timestamp-counter read logic"""

import sys
import time
from typing import Callable

from . import _native

_Timer = Callable[[], int]


def _sane(fn: _Timer) -> bool:
    """A usable counter returns nonzero, non-decreasing values."""
    try:
        samples = [fn() for _ in range(8)]
    except Exception:
        return False
    return samples[0] > 0 and all(b >= a for a, b in zip(samples, samples[1:]))


def _select_backend() -> tuple[str, _Timer, _Timer, _Timer]:
    arch = _native.machine_arch()
    if arch is not None:
        try:
            stubs = _native.stubs_for_arch(arch)
            loaded = [_native.load_stub(stubs[name]) for name in (
                "ReadCPUTimer", "ReadCPUTimerStartFenced", "ReadCPUTimerEndFenced")]
            if all(_sane(f) for f in loaded):
                return (f"native-{arch}", *loaded)
        except Exception:
            pass

    if sys.platform == "darwin":
        try:
            mat = _native.mach_absolute_time()
            if _sane(mat):
                return ("mach_absolute_time", mat, mat, mat)
        except Exception:
            pass

    pc = time.perf_counter_ns
    return ("perf_counter_ns", pc, pc, pc)


# The public names are bound straight to the backend callables, with no Python
# wrapper, so each read costs as little interpreter overhead as possible.
#
#   ReadCPUTimer()            -> int   unfenced read
#   ReadCPUTimerStartFenced() -> int   read after all earlier instructions finish
#   ReadCPUTimerEndFenced()   -> int   read before any later instructions start
TIMER_BACKEND: str
ReadCPUTimer: _Timer
ReadCPUTimerStartFenced: _Timer
ReadCPUTimerEndFenced: _Timer
TIMER_BACKEND, ReadCPUTimer, ReadCPUTimerStartFenced, ReadCPUTimerEndFenced = _select_backend()


def _select_frequency_reader() -> _Timer:
    if TIMER_BACKEND == "perf_counter_ns":
        return lambda: 1_000_000_000
    if TIMER_BACKEND == "native-arm64":
        try:
            return _native.load_stub(_native.ARM64_STUBS["ReadCPUTimerFrequency"])
        except Exception:
            pass
    # RDTSC and the macOS fallback are calibrated against the OS timer.
    return lambda: 0


# Zero means the backend needs calibration.
ReadCPUTimerFrequency: _Timer = _select_frequency_reader()
