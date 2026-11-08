package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Hardware describes the machine running this executor.
// Missing kernel files are expected on unsupported or restricted hosts.
type Hardware struct {
	CPUModel      string      `json:"cpuModel,omitempty"`
	PhysicalCores int         `json:"physicalCores,omitempty"`
	MemoryBytes   uint64      `json:"memoryBytes,omitempty"`
	Kernel        string      `json:"kernel,omitempty"`
	Governor      string      `json:"governor,omitempty"`
	Caches        []CacheInfo `json:"caches,omitempty"`
}

type CacheInfo struct {
	Level      string `json:"level"`
	Type       string `json:"type"`
	SizeBytes  uint64 `json:"sizeBytes"`
	SharedCPUs string `json:"sharedCpus,omitempty"`
}

func machineHardware() *Hardware {
	if runtime.GOOS != "linux" {
		return nil
	}
	return readLinuxHardware("/")
}

func readLinuxHardware(root string) *Hardware {
	read := func(path string) string {
		data, _ := os.ReadFile(filepath.Join(root, path))
		return strings.TrimSpace(string(data))
	}
	h := &Hardware{Kernel: read("proc/sys/kernel/osrelease"), Governor: read("sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")}
	for line := range strings.SplitSeq(read("proc/cpuinfo"), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok && strings.TrimSpace(key) == "model name" {
			h.CPUModel = strings.TrimSpace(value)
			break
		}
	}
	for line := range strings.SplitSeq(read("proc/meminfo"), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) == 3 && fields[2] == "kB" {
				amount, _ := strconv.ParseUint(fields[1], 10, 64)
				h.MemoryBytes = amount * 1024
			}
		}
	}
	// Count package/core pairs; core IDs may repeat between sockets.
	cores := map[string]bool{}
	cpus, _ := filepath.Glob(filepath.Join(root, "sys/devices/system/cpu/cpu[0-9]*"))
	for _, cpu := range cpus {
		core, err := os.ReadFile(filepath.Join(cpu, "topology/core_id"))
		pkg, pkgErr := os.ReadFile(filepath.Join(cpu, "topology/physical_package_id"))
		if err == nil && pkgErr == nil {
			coreID, coreErr := strconv.Atoi(strings.TrimSpace(string(core)))
			packageID, packageErr := strconv.Atoi(strings.TrimSpace(string(pkg)))
			if coreErr == nil && packageErr == nil && coreID >= 0 && packageID >= 0 {
				cores[strconv.Itoa(packageID)+":"+strconv.Itoa(coreID)] = true
			}
		}
	}
	h.PhysicalCores = len(cores)
	// CPU 0's cache hierarchy: one instance per level/type, never summed across CPUs.
	indices, _ := filepath.Glob(filepath.Join(root, "sys/devices/system/cpu/cpu0/cache/index*"))
	for _, index := range indices {
		rel, _ := filepath.Rel(root, index)
		size := cacheBytes(read(filepath.Join(rel, "size")))
		level, kind := read(filepath.Join(rel, "level")), read(filepath.Join(rel, "type"))
		if size > 0 && level != "" && kind != "" {
			h.Caches = append(h.Caches, CacheInfo{level, kind, size, read(filepath.Join(rel, "shared_cpu_list"))})
		}
	}
	return h
}

func cacheBytes(value string) uint64 {
	multiplier := uint64(1)
	if strings.HasSuffix(value, "K") {
		multiplier, value = 1024, strings.TrimSuffix(value, "K")
	} else if strings.HasSuffix(value, "M") {
		multiplier, value = 1024*1024, strings.TrimSuffix(value, "M")
	}
	amount, _ := strconv.ParseUint(value, 10, 64)
	return amount * multiplier
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	hostname, _ := os.Hostname()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Status   string    `json:"status"`
		Hostname string    `json:"hostname"`
		OS       string    `json:"os"`
		Arch     string    `json:"arch"`
		CPUs     int       `json:"cpus"`
		Hardware *Hardware `json:"hardware,omitempty"`
	}{"ok", hostname, runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), machineHardware()})
}
