# Python tests

Run from the repository root with Python 3.10 or newer. No third-party packages
are required.

```sh
# All tests, including the deterministic profiler unit tests
python3 -m unittest discover -s execution/py/tests -v

# Addition and integer division
python3 -m unittest -v execution.py.tests.test_arithmetic

# Addition only
python3 -m unittest -v execution.py.tests.test_arithmetic.ArithmeticTests.test_addition

# Division only
python3 -m unittest -v execution.py.tests.test_arithmetic.ArithmeticTests.test_division

# File I/O only
python3 -m unittest -v execution.py.tests.test_fileio

# Deterministic unit tests only (no hardware-counter access required)
python3 -m unittest -v execution.py.tests.test_profile
```

The workload tests follow the Go tests: each runs fenced and unfenced timer reads
for 100 ms each, checks the workload's output, and prints timing, throughput,
page faults, L1 data misses, and branch misses. Every invocation collects fresh
measurements. Avoid unittest's `-b` option when you want to see metrics from
successful tests, since it buffers their output.

Arithmetic uses 4,096 unsigned 64-bit array elements. Bytes per iteration count
two input arrays and one output array; Python interpreter and object overhead
are included in the measured time but not in that byte count. File I/O writes
and reads a temporary file, checks its contents, and removes it afterward. It
includes filesystem caching and open/close calls, without calling `fsync`.

Like the Go tests, the workload tests require access to hardware performance
counters. The current Python counter backend supports Linux; unavailable or
restricted counters cause an error rather than reporting simulated metrics.
