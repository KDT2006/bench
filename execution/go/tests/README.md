# Tests

Run from `execution/go`:

```sh
go test -v -count=1 ./tests
go test -v -count=1 ./tests -run 'TestAddition|TestDivision'
go test -v -count=1 ./tests -run TestFileIO
```

- `arithmetic_test.go`: addition and integer division, with output checks.
- `fileio_test.go`: write/read a temporary file and check its contents.
- `profile_test.go`: shared helper for running and printing profiles.

Each test profiles fenced and unfenced reads for 100 ms each. `-v` shows the
metrics; `-count=1` runs fresh measurements. File I/O includes filesystem caching
and does not call `fsync`. The profiler currently requires access to hardware
performance counters.
