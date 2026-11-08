package main

import (
	"context"
	"testing"
	"time"
)

func TestCompilerOptionsAffectBuiltBenchmark(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := RunExecution(ctx, ExecutionConfig{
		Name: "compiler options", BenchDuration: 5 * time.Millisecond,
		CompilerFlags: []string{"-gcflags=-N -l", "-ldflags", "-X main.buildSetting=enabled"},
		Globals:       `var buildSetting = "default"`,
		Bench:         `if buildSetting != "enabled" { panic("linker option was not applied") }`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Iterations < 1 {
		t.Fatal("no measured iterations")
	}
}

func TestCompilerOptionsRejectEntrypointOverrides(t *testing.T) {
	for _, flags := range [][]string{{"-o", "other"}, {"-toolexec=echo"}, {"-gcflags"}, {"main.go"}, {"-race=perhaps"}, {""}, {"-tags=\x00bad"}} {
		_, err := ParseExecutionConfig(ExecutionRequest{Name: "x", Code: "#bench", CompilerFlags: flags})
		if err == nil {
			t.Errorf("accepted invalid flags: %q", flags)
		}
	}
}
