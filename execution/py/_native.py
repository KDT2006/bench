"""Native CPU timer instructions and executable-memory helpers."""

from __future__ import annotations

import ctypes
import ctypes.util
import mmap
import platform
import sys
from typing import Callable

# Stub bytes

_X86_SHL_OR_RET = bytes.fromhex(
    "48C1E220"  # shl rdx, 32      ; move the high 32 bits up
    "4809D0"    # or  rax, rdx     ; OR in the low 32 bits
    "C3"        # ret
)
_LFENCE = bytes.fromhex("0FAEE8")
_RDTSC = bytes.fromhex("0F31")
_RDTSCP = bytes.fromhex("0F01F9")

X86_64_STUBS = {
    "ReadCPUTimer": _RDTSC + _X86_SHL_OR_RET,
    # lfence: wait for all previous instructions; lfence: wait for rdtsc
    "ReadCPUTimerStartFenced": _LFENCE + _RDTSC + _LFENCE + _X86_SHL_OR_RET,
    # rdtscp waits for previous instructions; lfence stops later ones starting early
    "ReadCPUTimerEndFenced": _RDTSCP + _LFENCE + _X86_SHL_OR_RET,
}


_A64_ISB = bytes.fromhex("DF3F03D5")
_A64_MRS_X0_CNTVCT = bytes.fromhex("40E03BD5")  # mrs x0, cntvct_el0
_A64_RET = bytes.fromhex("C0035FD6")

ARM64_STUBS = {
    "ReadCPUTimer": _A64_MRS_X0_CNTVCT + _A64_RET,
    "ReadCPUTimerStartFenced": _A64_ISB + _A64_MRS_X0_CNTVCT + _A64_ISB + _A64_RET,
    "ReadCPUTimerEndFenced": _A64_ISB + _A64_MRS_X0_CNTVCT + _A64_RET,
}

_StubFunc = ctypes.CFUNCTYPE(ctypes.c_uint64)

# Keep allocations alive for the process.
_keepalive: list[object] = []


def machine_arch() -> str | None:
    return {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }.get(platform.machine().lower())


def stubs_for_arch(arch: str) -> dict[str, bytes]:
    return {"x86_64": X86_64_STUBS, "arm64": ARM64_STUBS}[arch]


def _bind(fn, restype, *argtypes):
    """Declare a C function's signature and return the callable."""
    fn.argtypes = argtypes
    fn.restype = restype
    return fn


def _exec_linux(code: bytes) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    _bind(libc.mprotect, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int)

    size = mmap.PAGESIZE
    buf = mmap.mmap(-1, size, prot=mmap.PROT_READ | mmap.PROT_WRITE)
    buf.write(code)
    addr = ctypes.addressof(ctypes.c_char.from_buffer(buf))
    # W^X: drop write permission before making the page executable.
    if libc.mprotect(addr, size, mmap.PROT_READ | mmap.PROT_EXEC) != 0:
        raise OSError(ctypes.get_errno(), "mprotect failed")
    _keepalive.append(buf)
    return addr


def _exec_darwin(code: bytes) -> int:
    MAP_JIT = 0x0800
    libsys = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    _bind(libsys.pthread_jit_write_protect_np, None, ctypes.c_int)
    _bind(libsys.sys_icache_invalidate, None, ctypes.c_void_p, ctypes.c_size_t)

    size = mmap.PAGESIZE
    buf = mmap.mmap(
        -1,
        size,
        flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS | MAP_JIT,
        prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC,
    )
    addr = ctypes.addressof(ctypes.c_char.from_buffer(buf))
    libsys.pthread_jit_write_protect_np(0)  # make JIT pages writable for this thread
    try:
        ctypes.memmove(addr, code, len(code))
    finally:
        libsys.pthread_jit_write_protect_np(1)  # back to executable
    libsys.sys_icache_invalidate(addr, len(code))
    _keepalive.append(buf)
    return addr


def _exec_windows(code: bytes) -> int:
    MEM_COMMIT_RESERVE = 0x3000
    PAGE_READWRITE = 0x04
    PAGE_EXECUTE_READ = 0x20

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _bind(k32.VirtualAlloc, ctypes.c_void_p,
          ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_uint32)
    _bind(k32.VirtualProtect, ctypes.c_int,
          ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32))
    _bind(k32.GetCurrentProcess, ctypes.c_void_p)
    _bind(k32.FlushInstructionCache, ctypes.c_int,
          ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t)

    size = mmap.PAGESIZE
    addr = k32.VirtualAlloc(None, size, MEM_COMMIT_RESERVE, PAGE_READWRITE)
    if not addr:
        raise ctypes.WinError(ctypes.get_last_error())
    ctypes.memmove(addr, code, len(code))
    old = ctypes.c_uint32()
    if not k32.VirtualProtect(addr, size, PAGE_EXECUTE_READ, ctypes.byref(old)):
        raise ctypes.WinError(ctypes.get_last_error())
    k32.FlushInstructionCache(k32.GetCurrentProcess(), addr, len(code))
    return addr


def load_stub(code: bytes) -> Callable[[], int]:
    """Copy `code` into executable memory and return it as a ctypes callable."""
    if sys.platform.startswith("linux"):
        addr = _exec_linux(code)
    elif sys.platform == "darwin":
        addr = _exec_darwin(code)
    elif sys.platform == "win32":
        addr = _exec_windows(code)
    else:
        raise OSError(f"unsupported platform for native stubs: {sys.platform}")
    return _StubFunc(addr)


def mach_absolute_time() -> Callable[[], int]:
    """macOS fallback: reads the same counter as CNTVCT_EL0 on Apple Silicon."""
    libsys = ctypes.CDLL(ctypes.util.find_library("System") or "/usr/lib/libSystem.B.dylib")
    return _bind(libsys.mach_absolute_time, ctypes.c_uint64)
