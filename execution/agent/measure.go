package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
)

var sink uint64

func main() {
	arr, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	warmup, _ := strconv.Atoi(os.Args[1])
	reps, _ := strconv.Atoi(os.Args[2])
	window, _ := strconv.Atoi(os.Args[3])
	for range warmup {
		sink = benchmark(arr)
	}
	samples := make([]int64, 0, reps)
	deadline := time.Now().Add(time.Duration(window) * time.Millisecond)
	for len(samples) < reps {
		start := time.Now()
		sink = benchmark(arr)
		samples = append(samples, time.Since(start).Nanoseconds())
		if !time.Now().Before(deadline) {
			break
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(samples); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
