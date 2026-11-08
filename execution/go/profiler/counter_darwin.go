package profiler

import (
	"fmt"
	"sync"

	"profiler/kpc"
)

// kpc is configured once per process: independent HardwareCounters share the
// PMU session and each reports the delta of its own register. Reads are per
// thread, so Start and Stop must run on the locked benchmark thread (as
// RepetitionProfile.Start guarantees).
var (
	kpcMu   sync.Mutex
	kpcRefs int
)

var darwinEventIndex = map[Event]int{
	EventL1DataMisses: kpc.L1DataMisses,
	EventBranchMisses: kpc.BranchMisses,
}

func NewCounter(e Event) (HardwareCounter, error) {
	idx, ok := darwinEventIndex[e]
	if !ok {
		return nil, fmt.Errorf("unsupported event on darwin")
	}
	kpcMu.Lock()
	defer kpcMu.Unlock()
	if kpcRefs == 0 {
		if err := kpc.Open(); err != nil {
			return nil, err
		}
	}
	kpcRefs++
	return &darwinCounter{idx: idx}, nil
}

type darwinCounter struct {
	idx    int
	start  uint64
	delta  int64
	closed bool
}

func (d *darwinCounter) Start() error {
	v, err := kpc.Read(d.idx)
	d.start = v
	return err
}

func (d *darwinCounter) Stop() error {
	v, err := kpc.Read(d.idx)
	if err != nil {
		return err
	}
	d.delta = int64(v - d.start)
	return nil
}

func (d *darwinCounter) Read() (int64, error) { return d.delta, nil }

func (d *darwinCounter) Close() error {
	if d.closed {
		return nil
	}
	d.closed = true
	kpcMu.Lock()
	defer kpcMu.Unlock()
	kpcRefs--
	if kpcRefs == 0 {
		kpc.Close()
	}
	return nil
}
