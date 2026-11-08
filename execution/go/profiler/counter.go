package profiler

// HardwareCounter is implemented by all the individual counters
// to manage its lifecycle.
type HardwareCounter interface {
	Start() error
	Stop() error
	Read() (int64, error)
	Close() error
}

// Event represents a specific hardware counter
type Event byte

const (
	EventBranchMisses Event = iota
	EventL1DataMisses
)

// CounterAvailability distinguishes measured zero counts from unavailable events.
type CounterAvailability struct {
	L1DataMisses bool `json:"l1DataMisses"`
	BranchMisses bool `json:"branchMisses"`
}

type optionalCounter struct {
	counter   HardwareCounter
	available bool
}

func openOptionalCounter(event Event) *optionalCounter {
	counter, err := NewCounter(event)
	return &optionalCounter{counter: counter, available: err == nil && counter != nil}
}

func (c *optionalCounter) fail() {
	c.available = false
	if c.counter != nil {
		_ = c.counter.Stop()
		_ = c.counter.Close()
		c.counter = nil
	}
}

func (c *optionalCounter) start() {
	if c.available && c.counter.Start() != nil {
		c.fail()
	}
}

func (c *optionalCounter) stopRead() int64 {
	if !c.available {
		return 0
	}
	if err := c.counter.Stop(); err != nil {
		c.fail()
		return 0
	}
	value, err := c.counter.Read()
	if err != nil || value < 0 {
		c.fail()
		return 0
	}
	return value
}

func (c *optionalCounter) close() {
	if c.counter == nil {
		return
	}
	if err := c.counter.Close(); err != nil {
		c.available = false
	}
	c.counter = nil
}
