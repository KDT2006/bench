"""macOS hardware counters via the private kperf/kperfdata frameworks (Apple Silicon).

Requires root. kpc is configured once per process: both counters share one PMU
session and each reports the delta of its own register. Reads are per thread,
so Start and Stop must run on the same thread.
"""

from __future__ import annotations

import ctypes
import threading

from .counter import Event, HardwareCounter

_KPERF = "/System/Library/PrivateFrameworks/kperf.framework/kperf"
_KPERFDATA = "/System/Library/PrivateFrameworks/kperfdata.framework/kperfdata"

# Programmed in this order, so register index 0 is L1D misses and 1 is branch mispredicts.
_EVENT_NAMES = ("L1D_CACHE_MISS_LD_NONSPEC", "BRANCH_MISPRED_NONSPEC")
_EVENT_INDEX = {Event.EventL1DataMisses: 0, Event.EventBranchMisses: 1}


class _KpepEvent(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("desc", ctypes.c_char_p), ("errata", ctypes.c_char_p),
                ("alias", ctypes.c_char_p), ("fallback", ctypes.c_char_p), ("mask", ctypes.c_uint32),
                ("number", ctypes.c_uint8), ("umask", ctypes.c_uint8), ("reserved", ctypes.c_uint8),
                ("is_fixed", ctypes.c_uint8)]


_lock = threading.Lock()
_refs = 0
_kp = None
_map = (0, 0)


def _open_session() -> None:
    global _kp, _map
    kd = ctypes.CDLL(_KPERFDATA)
    kp = ctypes.CDLL(_KPERF)
    p, u32p, u64p = ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint64)

    db, cfg = p(), p()
    if kd.kpep_db_create(None, ctypes.byref(db)) or kd.kpep_config_create(db, ctypes.byref(cfg)):
        raise OSError("could not create the macOS kpep event database")
    kd.kpep_config_force_counters(cfg)
    for name in _EVENT_NAMES:
        event = ctypes.POINTER(_KpepEvent)()
        err = ctypes.c_uint32(0)
        if kd.kpep_db_event(db, name.encode(), ctypes.byref(event)) or not event:
            raise OSError(f"macOS PMU event {name} not found")
        if kd.kpep_config_add_event(cfg, ctypes.byref(event), 0, ctypes.byref(err)):
            raise OSError(f"could not add macOS PMU event {name}")

    classes = ctypes.c_uint32(0)
    regs = (ctypes.c_uint64 * 32)()
    index_map = (ctypes.c_size_t * 32)()
    if (kd.kpep_config_kpc_classes(cfg, ctypes.byref(classes))
            or kd.kpep_config_kpc_map(cfg, index_map, ctypes.sizeof(index_map))
            or kd.kpep_config_kpc(cfg, regs, ctypes.sizeof(regs))):
        raise OSError("could not query the macOS kpc configuration")

    if kp.kpc_force_all_ctrs_set(1):
        raise PermissionError("hardware counters on macOS require root (run under sudo)")
    if (kp.kpc_set_config(classes, regs) or kp.kpc_set_counting(classes)
            or kp.kpc_set_thread_counting(classes)):
        kp.kpc_force_all_ctrs_set(0)
        raise OSError("could not enable macOS kpc counting")
    kp.kpc_get_thread_counters.argtypes = [ctypes.c_uint32, ctypes.c_uint32, u64p]
    _kp, _map = kp, (index_map[0], index_map[1])


def _close_session() -> None:
    global _kp
    if _kp is not None:
        _kp.kpc_set_counting(0)
        _kp.kpc_set_thread_counting(0)
        _kp.kpc_force_all_ctrs_set(0)
        _kp = None


def newDarwinCounter(e: Event) -> HardwareCounter:
    global _refs
    idx = _EVENT_INDEX.get(Event(e))
    if idx is None:
        raise ValueError("unsupported event on darwin")
    with _lock:
        if _refs == 0:
            _open_session()
        _refs += 1
    return darwinCounter(idx)


class darwinCounter(HardwareCounter):
    """Implements the generic HardwareCounter interface for macOS."""

    def __init__(self, idx: int) -> None:
        self.idx = idx
        self._start = 0
        self._delta = 0
        self._closed = False

    def _now(self) -> int:
        buf = (ctypes.c_uint64 * 32)()
        if _kp.kpc_get_thread_counters(0, 32, buf):
            raise OSError("reading kpc thread counters failed")
        return buf[_map[self.idx]]

    def Start(self) -> None:
        self._start = self._now()

    def Stop(self) -> None:
        self._delta = self._now() - self._start

    def Read(self) -> int:
        return self._delta

    def Close(self) -> None:
        global _refs
        if self._closed:
            return
        self._closed = True
        with _lock:
            _refs -= 1
            if _refs == 0:
                _close_session()
