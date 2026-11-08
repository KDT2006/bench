// Package kpc programs Apple Silicon performance counters through the private
// kperf/kperfdata frameworks. It is separate from package profiler because a
// cgo package cannot contain Go assembly files. Requires root.
package kpc

/*
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

// Private kperf/kperfdata API (Apple Silicon). Loaded with dlopen because the
// frameworks live in the dyld shared cache and have no link stubs.
typedef struct { const char *name, *desc, *errata, *alias, *fallback; uint32_t mask; uint8_t number, umask, reserved, is_fixed; } kpep_event;
typedef struct kpep_db kpep_db;
typedef struct kpep_config kpep_config;

static int (*kpep_db_create)(const char*, kpep_db**);
static int (*kpep_db_event)(kpep_db*, const char*, kpep_event**);
static int (*kpep_config_create)(kpep_db*, kpep_config**);
static int (*kpep_config_add_event)(kpep_config*, kpep_event**, uint32_t, uint32_t*);
static int (*kpep_config_force_counters)(kpep_config*);
static int (*kpep_config_kpc)(kpep_config*, uint64_t*, size_t);
static int (*kpep_config_kpc_classes)(kpep_config*, uint32_t*);
static int (*kpep_config_kpc_map)(kpep_config*, size_t*, size_t);
static int (*kpc_force_all_ctrs_set)(int);
static int (*kpc_set_config)(uint32_t, void*);
static int (*kpc_set_counting)(uint32_t);
static int (*kpc_set_thread_counting)(uint32_t);
static int (*kpc_get_thread_counters)(uint32_t, uint32_t, uint64_t*);

#define BIND(h, n) do { *(void**)&n = dlsym(h, #n); if (!n) return -100; } while (0)

static size_t counter_map[2];

// kpcOpen programs both events into the PMU. Index 0 is L1D load misses and
// index 1 is branch mispredicts. Returns 0 on success, a nonzero code on failure
// (-1 from kpc_force_all_ctrs_set means not running as root).
static int kpcOpen(void) {
	void *kd = dlopen("/System/Library/PrivateFrameworks/kperfdata.framework/kperfdata", RTLD_LAZY);
	void *kp = dlopen("/System/Library/PrivateFrameworks/kperf.framework/kperf", RTLD_LAZY);
	if (!kd || !kp) return -101;
	BIND(kd, kpep_db_create); BIND(kd, kpep_db_event); BIND(kd, kpep_config_create);
	BIND(kd, kpep_config_add_event); BIND(kd, kpep_config_force_counters); BIND(kd, kpep_config_kpc);
	BIND(kd, kpep_config_kpc_classes); BIND(kd, kpep_config_kpc_map);
	BIND(kp, kpc_force_all_ctrs_set); BIND(kp, kpc_set_config); BIND(kp, kpc_set_counting);
	BIND(kp, kpc_set_thread_counting); BIND(kp, kpc_get_thread_counters);

	const char *names[2] = {"L1D_CACHE_MISS_LD_NONSPEC", "BRANCH_MISPRED_NONSPEC"};
	kpep_db *db = NULL;
	kpep_config *cfg = NULL;
	if (kpep_db_create(NULL, &db) || kpep_config_create(db, &cfg)) return -102;
	kpep_config_force_counters(cfg);
	for (int i = 0; i < 2; i++) {
		kpep_event *e = NULL;
		uint32_t err = 0;
		if (kpep_db_event(db, names[i], &e) || !e) return -103;
		if (kpep_config_add_event(cfg, &e, 0, &err)) return -104;
	}
	uint32_t classes = 0;
	uint64_t regs[32] = {0};
	size_t map[32] = {0};
	if (kpep_config_kpc_classes(cfg, &classes) || kpep_config_kpc_map(cfg, map, sizeof map) ||
	    kpep_config_kpc(cfg, regs, sizeof regs)) return -105;
	counter_map[0] = map[0];
	counter_map[1] = map[1];

	int r = kpc_force_all_ctrs_set(1);
	if (r) return r;
	if (kpc_set_config(classes, regs) || kpc_set_counting(classes) || kpc_set_thread_counting(classes)) {
		kpc_force_all_ctrs_set(0);
		return -106;
	}
	return 0;
}

static void kpcClose(void) {
	kpc_set_counting(0);
	kpc_set_thread_counting(0);
	kpc_force_all_ctrs_set(0);
}

// kpcRead reads the calling thread's cumulative count for counter idx.
static int kpcRead(int idx, uint64_t *out) {
	uint64_t buf[32];
	if (kpc_get_thread_counters(0, 32, buf)) return -1;
	*out = buf[counter_map[idx]];
	return 0;
}
*/
import "C"

import "fmt"

// Event indexes: the order the events are programmed in kpcOpen.
const (
	L1DataMisses = 0
	BranchMisses = 1
)

// ErrNotRoot is returned by Open when the process lacks the privileges to use kpc.
var ErrNotRoot = fmt.Errorf("hardware counters on macOS require root (run under sudo)")

// Open programs both events into the PMU. Callers must pair it with Close.
func Open() error {
	switch r := C.kpcOpen(); r {
	case 0:
		return nil
	case -1:
		return ErrNotRoot
	default:
		return fmt.Errorf("opening macOS kpc counters failed (code %d)", int(r))
	}
}

// Close releases the PMU.
func Close() { C.kpcClose() }

// Read returns the calling thread's cumulative count for event idx. The caller
// must stay on one OS thread between reads.
func Read(idx int) (uint64, error) {
	var v C.uint64_t
	if C.kpcRead(C.int(idx), &v) != 0 {
		return 0, fmt.Errorf("reading kpc thread counters failed")
	}
	return uint64(v), nil
}
