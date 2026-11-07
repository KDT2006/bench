"""Per-OS page-fault counting logic"""

from __future__ import annotations

import sys

# windows does not differentiate between major and minor faults.
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.GetCurrentProcess.restype = wintypes.HANDLE
    _k32.K32GetProcessMemoryInfo.argtypes = (
        wintypes.HANDLE, ctypes.POINTER(_PROCESS_MEMORY_COUNTERS), wintypes.DWORD)
    _k32.K32GetProcessMemoryInfo.restype = wintypes.BOOL

    def getPageFaults() -> tuple[int, int]:
        """Windows doesn't split major/minor; all faults are reported as minor."""
        pmc = _PROCESS_MEMORY_COUNTERS()
        pmc.cb = ctypes.sizeof(pmc)
        if not _k32.K32GetProcessMemoryInfo(_k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return 0, int(pmc.PageFaultCount)

# For linux and MacOS
else:
    try:
        import resource
    except ImportError:  # pragma: no cover - exotic platforms
        resource = None  # type: ignore[assignment]

    def getPageFaults() -> tuple[int, int]:
        """Return (major, minor) page faults for this process (Linux, macOS)."""
        if resource is None:
            raise NotImplementedError("page-fault counting not implemented on this platform")
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return usage.ru_majflt, usage.ru_minflt
