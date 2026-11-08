from pathlib import Path
import tempfile
import unittest

from execution.py.hardware import linux_hardware


class HardwareTests(unittest.TestCase):
    def test_optional_linux_metadata_and_shared_cores(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(linux_hardware(root), {})
            files = {
                "proc/cpuinfo": "processor: 0\nmodel name: Python CPU\n",
                "proc/meminfo": "MemTotal: 8192 kB\n",
                "sys/devices/system/cpu/cpu0/cache/index0/size": "48K",
                "sys/devices/system/cpu/cpu0/cache/index0/level": "1",
                "sys/devices/system/cpu/cpu0/cache/index0/type": "Data",
                "sys/devices/system/cpu/cpu0/cache/index0/shared_cpu_list": "0-1",
            }
            for cpu, package in [(0, 0), (1, 0), (2, 1)]:
                files[f"sys/devices/system/cpu/cpu{cpu}/topology/core_id"] = "0"
                files[f"sys/devices/system/cpu/cpu{cpu}/topology/physical_package_id"] = str(package)
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            info = linux_hardware(root)
            self.assertEqual(info["cpuModel"], "Python CPU")
            self.assertEqual(info["physicalCores"], 2)
            self.assertEqual(info["memoryBytes"], 8192 * 1024)
            self.assertEqual(info["caches"][0]["sizeBytes"], 48 * 1024)
            self.assertNotIn("governor", info)
