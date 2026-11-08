package profiler

import (
	"encoding/binary"
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Pin events so unscheduled counters fail instead of reporting unscaled,
// multiplexed counts. Count user-space work only.
const bitFields = unix.PerfBitDisabled | unix.PerfBitPinned | unix.PerfBitExcludeKernel | unix.PerfBitExcludeHv

// eventConfig maps linux generic event types to perf events
var eventConfig = map[Event]*unix.PerfEventAttr{
	EventBranchMisses: {
		Type:   unix.PERF_TYPE_HARDWARE,
		Config: unix.PERF_COUNT_HW_BRANCH_MISSES,
		Size:   uint32(unsafe.Sizeof(unix.PerfEventAttr{})),
		Bits:   bitFields,
	},

	EventL1DataMisses: {
		Type: unix.PERF_TYPE_HW_CACHE,
		Config: unix.PERF_COUNT_HW_CACHE_L1D |
			(unix.PERF_COUNT_HW_CACHE_OP_READ << 8) |
			unix.PERF_COUNT_HW_CACHE_RESULT_MISS<<16,
		Size: uint32(unsafe.Sizeof(unix.PerfEventAttr{})),
		Bits: bitFields,
	},
}

func NewCounter(e Event) (HardwareCounter, error) {
	attr, ok := eventConfig[e]
	if !ok {
		return nil, fmt.Errorf("unsupported event on linux")
	}

	fd, err := unix.PerfEventOpen(attr, 0, -1, -1, unix.PERF_FLAG_FD_CLOEXEC)
	if err != nil {
		return nil, fmt.Errorf("error opening perf event file: %v\n", err)
	}

	return &linuxCounter{fd: fd}, nil
}

// linuxCounter implements the generic HardwareCounter interface for linux
type linuxCounter struct {
	fd int
}

func (l *linuxCounter) Start() error {
	if err := unix.IoctlSetInt(l.fd, unix.PERF_EVENT_IOC_RESET, 0); err != nil {
		return err
	}
	return unix.IoctlSetInt(l.fd, unix.PERF_EVENT_IOC_ENABLE, 0)
}

func (l *linuxCounter) Stop() error {
	return unix.IoctlSetInt(l.fd, unix.PERF_EVENT_IOC_DISABLE, 0)
}

func (l *linuxCounter) Read() (int64, error) {
	var buf [8]byte
	n, err := unix.Read(l.fd, buf[:])
	if err != nil {
		return 0, err
	}
	if n != len(buf) {
		return 0, fmt.Errorf("short hardware counter read: %d bytes", n)
	}

	return int64(binary.LittleEndian.Uint64(buf[:])), nil
}

func (l *linuxCounter) Close() error {
	return unix.Close(l.fd)
}
