package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxHardware(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"proc/cpuinfo":              "processor: 0\nmodel name: Test CPU\n",
		"proc/meminfo":              "MemTotal: 8192 kB\nMemFree: 1024 kB\n",
		"proc/sys/kernel/osrelease": "6.8-test\n",
		"sys/devices/system/cpu/cpu0/topology/core_id":             "0\n",
		"sys/devices/system/cpu/cpu0/topology/physical_package_id": "0\n",
		"sys/devices/system/cpu/cpu1/topology/core_id":             "0\n",
		"sys/devices/system/cpu/cpu1/topology/physical_package_id": "0\n",
		"sys/devices/system/cpu/cpu2/topology/core_id":             "0\n",
		"sys/devices/system/cpu/cpu2/topology/physical_package_id": "1\n",
		"sys/devices/system/cpu/cpu3/topology/core_id":             "-1\n",
		"sys/devices/system/cpu/cpu3/topology/physical_package_id": "-1\n",
		"sys/devices/system/cpu/cpu0/cpufreq/scaling_governor":     "performance\n",
		"sys/devices/system/cpu/cpu0/cache/index0/size":            "48K\n",
		"sys/devices/system/cpu/cpu0/cache/index0/level":           "1\n",
		"sys/devices/system/cpu/cpu0/cache/index0/type":            "Data\n",
		"sys/devices/system/cpu/cpu0/cache/index0/shared_cpu_list": "0-1\n",
		"sys/devices/system/cpu/cpu0/cache/index1/size":            "invalid\n",
	}
	for name, contents := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := readLinuxHardware(root)
	if h.CPUModel != "Test CPU" || h.PhysicalCores != 2 || h.MemoryBytes != 8192*1024 || h.Kernel != "6.8-test" || h.Governor != "performance" {
		t.Fatalf("unexpected hardware: %+v", h)
	}
	if len(h.Caches) != 1 || h.Caches[0].SizeBytes != 48*1024 || h.Caches[0].SharedCPUs != "0-1" {
		t.Fatalf("unexpected caches: %+v", h.Caches)
	}
}

func TestLinuxHardwareMissingFiles(t *testing.T) {
	h := readLinuxHardware(t.TempDir())
	if h.CPUModel != "" || h.PhysicalCores != 0 || h.MemoryBytes != 0 || len(h.Caches) != 0 {
		t.Fatalf("missing data should stay unavailable: %+v", h)
	}
}
