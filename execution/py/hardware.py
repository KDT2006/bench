"""Machine metadata collected inside the executor, never by the proxy."""
import os
from pathlib import Path
import platform
import socket


def linux_hardware(root=Path("/")):
    def read(path):
        try:
            return (root / path).read_text().strip()
        except (OSError, UnicodeError):
            return ""

    hardware = {}
    for line in read("proc/cpuinfo").splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() == "model name":
            hardware["cpuModel"] = value.strip()
            break
    for line in read("proc/meminfo").splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[0] == "MemTotal:" and fields[2] == "kB":
            try:
                hardware["memoryBytes"] = int(fields[1]) * 1024
            except ValueError:
                pass
    cores = set()
    for cpu in (root / "sys/devices/system/cpu").glob("cpu[0-9]*"):
        try:
            package = int((cpu / "topology/physical_package_id").read_text())
            core = int((cpu / "topology/core_id").read_text())
            if package >= 0 and core >= 0:
                cores.add((package, core))
        except (OSError, ValueError):
            pass
    if cores:
        hardware["physicalCores"] = len(cores)
    for key, path in [("kernel", "proc/sys/kernel/osrelease"), ("governor", "sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")]:
        if value := read(path):
            hardware[key] = value
    caches = []
    for index in sorted((root / "sys/devices/system/cpu/cpu0/cache").glob("index*")):
        rel = index.relative_to(root)
        size = read(rel / "size")
        multiplier = 1024 if size.endswith("K") else 1024 ** 2 if size.endswith("M") else 1
        try:
            amount = int(size.rstrip("KM")) * multiplier
        except ValueError:
            continue
        level, kind = read(rel / "level"), read(rel / "type")
        if amount > 0 and level and kind:
            caches.append(dict(level=level, type=kind, sizeBytes=amount, sharedCpus=read(rel / "shared_cpu_list")))
    if caches:
        hardware["caches"] = caches
    return hardware


def machine_health():
    arch = {"x86_64": "amd64", "AMD64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine(), platform.machine())
    result = dict(status="ok", hostname=socket.gethostname(), os=platform.system().lower(), arch=arch, cpus=os.cpu_count() or 1)
    if platform.system() == "Linux":
        result["hardware"] = linux_hardware()
    return result
