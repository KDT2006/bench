package profiler_test

import "testing"

// profile element-wise integer addition and checks the sum
func TestAddition(t *testing.T) {
	const size = 4096
	left, right, output := make([]uint64, size), make([]uint64, size), make([]uint64, size)
	for i := range left {
		left[i] = uint64(i)
		right[i] = uint64(2 * i)
	}

	runProfile(t, 3*8*size, func() {
		for i := range output {
			output[i] = left[i] + right[i]
		}
	})

	for i, got := range output {
		if want := uint64(3 * i); got != want {
			t.Fatalf("output[%d] = %d, want %d", i, got, want)
		}
	}
}

// profiles integer division and checks the truncated quotient
func TestDivision(t *testing.T) {
	const size = 4096
	numerators, divisors, output := make([]uint64, size), make([]uint64, size), make([]uint64, size)
	for i := range numerators {
		divisors[i] = uint64(i + 1)
		numerators[i] = divisors[i]*uint64(i%17) + divisors[i] - 1
	}

	runProfile(t, 3*8*size, func() {
		for i := range output {
			output[i] = numerators[i] / divisors[i]
		}
	})

	for i, got := range output {
		if want := uint64(i % 17); got != want {
			t.Fatalf("output[%d] = %d, want %d", i, got, want)
		}
	}
}
