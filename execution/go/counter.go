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
