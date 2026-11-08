//go:build !linux && !darwin

package profiler

import "fmt"

func NewCounter(event Event) (HardwareCounter, error) {
	return nil, fmt.Errorf("hardware counter %d is unavailable on this platform", event)
}
