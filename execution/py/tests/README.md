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

# Deterministic profiler unit tests
python3 -m unittest -v execution.py.tests.test_profile

# Generated programs, sweep execution, and HTTP server
python3 -m unittest -v execution.py.tests.test_execution execution.py.tests.test_http
```

The workload tests follow the Go tests: each runs fenced and unfenced timer reads
for 100 ms each, checks the workload's output, and prints timing, throughput,
and page faults. Every invocation collects fresh
measurements. Avoid unittest's `-b` option when you want to see metrics from
successful tests, since it buffers their output.

Arithmetic uses 4,096 unsigned 64-bit array elements. Bytes per iteration count
two input arrays and one output array; Python interpreter and object overhead
are included in the measured time but not in that byte count. File I/O writes
and reads a temporary file, checks its contents, and removes it afterward. It
includes filesystem caching and open/close calls, without calling `fsync`.

The profiler always tries to open hardware counters and prints their values
when it can, or `unavailable (<reason>)` when it can't. Workload and execution
tests pass either way, so they don't require perf permissions. Deterministic
tests exercise counter collection and setup failures with fakes. HTTP tests require permission to open localhost sockets.

See [the executioner README](../README.md) for the server, directive format,
proxy configuration, and updated iteration callback API.
