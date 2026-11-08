package main

import (
	"fmt"
	"strings"
)

// Accept build options that preserve the generated executable and source file.
// Arguments go straight to exec.Command, never through a shell.
func validateCompilerFlags(flags []string) error {
	if len(flags) > 64 {
		return fmt.Errorf("compilerFlags must contain at most 64 arguments")
	}
	for _, arg := range flags {
		if arg == "" || len(arg) > 4096 || strings.ContainsRune(arg, 0) {
			return fmt.Errorf("invalid compilerFlags argument: expected 1–4096 bytes without NUL characters")
		}
	}
	for i := 0; i < len(flags); i++ {
		name, value, hasValue := strings.Cut(flags[i], "=")
		switch name {
		case "-race", "-msan", "-asan", "-trimpath", "-cover", "-a", "-v", "-x":
			if hasValue && value != "true" && value != "false" {
				return fmt.Errorf("compiler option %s requires true or false", name)
			}
		case "-gcflags", "-asmflags", "-ldflags", "-tags", "-pgo", "-buildvcs", "-covermode", "-coverpkg":
			if !hasValue {
				i++
				if i >= len(flags) {
					return fmt.Errorf("compiler option %s requires a value", name)
				}
				value = flags[i]
			}
			if value == "" {
				return fmt.Errorf("compiler option %s requires a nonempty value", name)
			}
		default:
			return fmt.Errorf("unsupported Go compiler option %q; use -gcflags, -asmflags, -ldflags, -tags, -pgo, -buildvcs, -race, -msan, -asan, -trimpath, -cover, -covermode, -coverpkg, -a, -v or -x", name)
		}
	}
	return nil
}
