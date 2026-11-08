"""Linux hardware counters via perf_event_open (port of counter_linux.go)."""

from __future__ import annotations

import ctypes
import fcntl
import os
import platform

from .counter import Event, HardwareCounter

# perf_event_attr, PERF_ATTR_SIZE_VER0 (64-byte) layout. The kernel accepts it.
class _PerfEventAttr(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_uint32),
        ("size", ctypes.c_uint32),
        ("config", ctypes.c_uint64),
        ("sample_period", ctypes.c_uint64),
        ("sample_type", ctypes.c_uint64),
        ("read_format", ctypes.c_uint64),
        ("flags", ctypes.c_uint64),  # bitfield: disabled, inherit, pinned, ...
        ("wakeup_events", ctypes.c_uint32),
        ("bp_type", ctypes.c_uint32),
        ("config1", ctypes.c_uint64),
    ]


assert ctypes.sizeof(_PerfEventAttr) == 64

PERF_TYPE_HARDWARE = 0
PERF_TYPE_HW_CACHE = 3
PERF_COUNT_HW_BRANCH_MISSES = 5
PERF_COUNT_HW_CACHE_L1D = 0
PERF_COUNT_HW_CACHE_OP_READ = 0
PERF_COUNT_HW_CACHE_RESULT_MISS = 1

PERF_BIT_DISABLED = 1 << 0
PERF_BIT_EXCLUDE_KERNEL = 1 << 5
PERF_BIT_EXCLUDE_HV = 1 << 6

PERF_FLAG_FD_CLOEXEC = 1 << 3

PERF_FORMAT_TOTAL_TIME_ENABLED = 1 << 0
PERF_FORMAT_TOTAL_TIME_RUNNING = 1 << 1
# A read returns three u64s: value, time enabled, time running.
readFormat = PERF_FORMAT_TOTAL_TIME_ENABLED | PERF_FORMAT_TOTAL_TIME_RUNNING

PERF_EVENT_IOC_ENABLE = 0x2400
PERF_EVENT_IOC_DISABLE = 0x2401
PERF_EVENT_IOC_RESET = 0x2403

_SYS_PERF_EVENT_OPEN = {"x86_64": 298, "amd64": 298, "aarch64": 241, "arm64": 241}

# Disabled initially, and doesn't count kernel space or the hypervisor.
bitFields = PERF_BIT_DISABLED | PERF_BIT_EXCLUDE_KERNEL | PERF_BIT_EXCLUDE_HV

# Maps generic events to perf events: (type, config)
eventConfig: dict[Event, tuple[int, int]] = {
    Event.EventBranchMisses: (PERF_TYPE_HARDWARE, PERF_COUNT_HW_BRANCH_MISSES),
    Event.EventL1DataMisses: (
        PERF_TYPE_HW_CACHE,
        PERF_COUNT_HW_CACHE_L1D
        | (PERF_COUNT_HW_CACHE_OP_READ << 8)
        | (PERF_COUNT_HW_CACHE_RESULT_MISS << 16),
    ),
}

_libc = ctypes.CDLL(None, use_errno=True)
_libc.syscall.restype = ctypes.c_long


def _perf_event_open(attr: _PerfEventAttr, pid: int, cpu: int, group_fd: int, flags: int) -> int:
    nr = _SYS_PERF_EVENT_OPEN.get(platform.machine().lower())
    if nr is None:
        raise NotImplementedError(f"perf_event_open syscall number unknown for {platform.machine()}")
    fd = _libc.syscall(
        ctypes.c_long(nr), ctypes.byref(attr), ctypes.c_int(pid), ctypes.c_int(cpu),
        ctypes.c_int(group_fd), ctypes.c_ulong(flags))
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, f"error opening perf event file: {os.strerror(err)}")
    return fd


def newLinuxCounter(e: Event) -> HardwareCounter:
    cfg = eventConfig.get(Event(e))
    if cfg is None:
        raise ValueError("unsupported event on linux")
    attr = _PerfEventAttr(
        type=cfg[0], size=ctypes.sizeof(_PerfEventAttr), config=cfg[1],
        read_format=readFormat, flags=bitFields)
    counter = linuxCounter(_perf_event_open(attr, 0, -1, -1, PERF_FLAG_FD_CLOEXEC))
    try:
        counter.probe()
    except BaseException:
        counter.Close()
        raise
    return counter


class linuxCounter(HardwareCounter):
    """Implements the generic HardwareCounter interface for Linux."""

    def __init__(self, fd: int) -> None:
        self.fd = fd

    def Start(self) -> None:
        fcntl.ioctl(self.fd, PERF_EVENT_IOC_RESET, 0)
        fcntl.ioctl(self.fd, PERF_EVENT_IOC_ENABLE, 0)

    def Stop(self) -> None:
        fcntl.ioctl(self.fd, PERF_EVENT_IOC_DISABLE, 0)

    def _read(self) -> tuple[int, int, int]:
        """Return (value, time enabled ns, time running ns)."""
        data = os.read(self.fd, 24)
        if len(data) != 24:
            raise OSError(f"short perf counter read: {len(data)} bytes")
        return (int.from_bytes(data[0:8], "little", signed=True),
                int.from_bytes(data[8:16], "little"),
                int.from_bytes(data[16:24], "little"))

    def Read(self) -> int:
        return self._read()[0]

    def probe(self) -> None:
        """Fail if the counter never runs on this CPU.

        On hybrid CPUs, generic hardware events are bound to one core type's
        PMU; on the other core type they open fine but never count.
        """
        self.Start()
        sum(range(1000))
        self.Stop()
        _, enabled, running = self._read()
        if enabled and not running:
            raise OSError("counter does not run on this CPU; its core type lacks this PMU")

    def Close(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1
