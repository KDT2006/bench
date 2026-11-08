package profiler

import (
	"math/rand"
	"os"
	"runtime"
	"testing"
)

func TestGetPageFaultsCountsTouchedMemory(t *testing.T) {
	_, before, err := getPageFaults()
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64<<20)
	for i := 0; i < len(buf); i += 4096 {
		buf[i] = 1
	}
	_, after, err := getPageFaults()
	if err != nil {
		t.Fatal(err)
	}
	if after-before < 1000 {
		t.Fatalf("expected >=1000 minor faults touching 64 MiB, got %d", after-before)
	}
}

// Without root the counters must report unavailable; with root (sudo go test)
// a loop of random branches must register branch mispredicts.
func TestDarwinHardwareCounters(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	branch, err := NewCounter(EventBranchMisses)
	if os.Geteuid() != 0 {
		if err == nil {
			t.Fatal("expected counters to be unavailable without root")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	defer branch.Close()
	l1, err := NewCounter(EventL1DataMisses)
	if err != nil {
		t.Fatal(err)
	}
	defer l1.Close()

	rng := rand.New(rand.NewSource(1))
	data := make([]int, 1<<22)
	for i := range data {
		data[i] = rng.Intn(2)
	}
	branch.Start()
	l1.Start()
	n := 0
	for _, v := range data {
		if v == 1 {
			n++
		}
	}
	branch.Stop()
	l1.Stop()
	bm, _ := branch.Read()
	lm, _ := l1.Read()
	t.Logf("n=%d branch misses=%d l1 misses=%d", n, bm, lm)
	if bm <= 0 {
		t.Fatalf("expected branch mispredicts > 0, got %d", bm)
	}
}
