package profiler_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// TestFileIO profiles writing and reading a temporary file and checks its contents.
func TestFileIO(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.bin")
	payload := bytes.Repeat([]byte("profiler-file-io\n"), 4096)
	var output []byte
	var ioErr error

	// Measure writing and reading, including open/close, without fsync.
	runProfile(t, uint64(2*len(payload)), func() {
		if ioErr != nil {
			return
		}
		ioErr = os.WriteFile(path, payload, 0600)
		if ioErr == nil {
			output, ioErr = os.ReadFile(path)
		}
	})

	if ioErr != nil {
		t.Fatal(ioErr)
	}
	if !bytes.Equal(output, payload) {
		t.Fatal("file contents do not match the written payload")
	}
}
