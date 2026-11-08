package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNativeAssemblyExecution(t *testing.T) {
	testNativeABI(t, "native.S")
}

func TestNativeNASMExecution(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("NASM requires x64")
	}
	if _, err := exec.LookPath("nasm"); err != nil {
		t.Skip("nasm not installed")
	}
	testNativeABI(t, "native.asm")
}

func testNativeABI(t *testing.T, fixture string) {
	t.Helper()
	if err := nativePlatform(); err != nil {
		t.Skip(err)
	}
	if output, _ := exec.Command("go", "env", "CGO_ENABLED").Output(); strings.TrimSpace(string(output)) != "1" {
		t.Skip("cgo disabled")
	}
	assembly, err := os.ReadFile(filepath.Join("../testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseExecutionConfig(ExecutionRequest{Name: "native ABI", Assembly: string(assembly), Code: `#globals
func Add64(a, b uint64) uint64
func Store64(p *uint64, value uint64)
func Twice(value float64) float64
func Answer() uint64
func MultiNOP(count uint64)
func helper() uint64 { return 7 }
#sweep
N: [0, 9]
#setup
var value uint64
#bench
Store64(&value, Add64(1 << 40, helper()))
MultiNOP(uint64(N))
#cleanup
if value != (1 << 40) + 7 || Twice(1.25) != 2.5 || Answer() != 42 { panic("native ABI mismatch") }
`})
	if err != nil {
		t.Fatal(err)
	}
	cfg.BenchDuration = time.Millisecond
	if fixture == "native.asm" {
		cfg.Globals += "\nfunc MOVAllBytesASM(count uint64, data *byte)\nfunc CMPAllBytesASM(count uint64)\nfunc DECAllBytesASM(count uint64)\n"
		cfg.Setup += "buffer := [10]byte{255,255,255,255,255,255,255,255,255,255}\n"
		cfg.Bench += "MOVAllBytesASM(uint64(N), &buffer[0])\nCMPAllBytesASM(uint64(N))\nDECAllBytesASM(uint64(N))\n"
		cfg.Cleanup += "for i, value := range buffer { expected := byte(255); if i < N { expected = byte(i) }; if value != expected { panic(\"buffer overwritten\") } }\n"
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	results, err := RunSweep(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].Iterations <= 0 || results[1].Iterations <= 0 {
		t.Fatalf("missing measurements: %+v", results)
	}
}

func TestNativeNASMDetectionAndTargets(t *testing.T) {
	for _, source := range []string{"; comment\nglobal F\nsection .text", "[BITS 64]", "%define COUNT 9", "GLOBAL F", "section .text\nF:\n db 0x90\n ret"} {
		if !isNASM(source) {
			t.Errorf("NASM not detected: %q", source)
		}
	}
	for _, source := range []string{".text\n.globl F\nF:\nret", "// global F\n.text", "#ifdef __APPLE__\n.globl _F\n#endif", "// ARM64\n.text\n.globl F\nF:\nmov x9, #0\nret"} {
		if isNASM(source) {
			t.Errorf("GAS detected as NASM: %q", source)
		}
	}
	for _, target := range []struct {
		os   string
		want []string
	}{{"linux", []string{"-f", "elf64"}}, {"darwin", []string{"-f", "macho64", "--prefix", "_"}}} {
		got, err := nasmTarget(target.os, "amd64")
		if err != nil || !reflect.DeepEqual(got, target.want) {
			t.Fatalf("%s target: %v %v", target.os, got, err)
		}
	}
	if _, err := nasmTarget("darwin", "arm64"); err == nil {
		t.Fatal("accepted NASM on ARM64")
	}
}

func TestNativeNASMMacSymbols(t *testing.T) {
	if _, err := exec.LookPath("nasm"); err != nil {
		t.Skip("nasm not installed")
	}
	object := filepath.Join(t.TempDir(), "native.o")
	args, _ := nasmTarget("darwin", "amd64")
	args = append(args, "-o", object, "../testdata/native.asm")
	if output, err := exec.Command("nasm", args...).CombinedOutput(); err != nil {
		t.Fatalf("Mach-O assembly: %v\n%s", err, output)
	}
	data, err := os.ReadFile(object)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte{0xcf, 0xfa, 0xed, 0xfe}) {
		t.Fatal("not a 64-bit Mach-O object")
	}
	for _, name := range []string{"_Add64", "_NOPAllBytesASM", "_MOVAllBytesASM"} {
		if !bytes.Contains(data, []byte("\x00"+name+"\x00")) {
			t.Errorf("missing C ABI symbol %s", name)
		}
	}
}

func TestNativeDeclarationsAndLimits(t *testing.T) {
	for _, globals := range []string{"", "func f(x string)", "func f(x []byte)", "func f(x ...uint64)", "func f(uint64)", "func f() (uint64, uint64)", "func f[T any](x T)", "func (x T) f()"} {
		if _, err := bindNative(globals); err == nil {
			t.Errorf("accepted %q", globals)
		}
	}
	for _, field := range []string{"code", "assembly"} {
		req := ExecutionRequest{Name: "limit", Code: "#bench\n"}
		if field == "code" {
			req.Code = strings.Repeat("x", sourceCharLimit+1)
		} else {
			req.Assembly = strings.Repeat("x", sourceCharLimit+1)
		}
		if _, err := ParseExecutionConfig(req); err == nil || !strings.Contains(err.Error(), field) {
			t.Errorf("%s limit: %v", field, err)
		}
	}
	if err := validateSourceSize(strings.Repeat("🦊", sourceCharLimit), "assembly"); err != nil {
		t.Fatal(err)
	}
	if err := validateSourceSize("\x00", "assembly"); err == nil {
		t.Fatal("accepted NUL")
	}
}

func TestNativeAssemblerDiagnostics(t *testing.T) {
	if err := nativePlatform(); err != nil {
		t.Skip(err)
	}
	if output, _ := exec.Command("go", "env", "CGO_ENABLED").Output(); strings.TrimSpace(string(output)) != "1" {
		t.Skip("cgo disabled")
	}
	_, err := RunExecution(context.Background(), ExecutionConfig{Assembly: "this_is_not_an_instruction", Globals: "func f()", Bench: "f()"})
	if err == nil || !strings.Contains(err.Error(), "compile native assembly") {
		t.Fatalf("missing assembly diagnostic: %v", err)
	}
}

func TestNativeRequiresCGO(t *testing.T) {
	if err := nativePlatform(); err != nil {
		t.Skip(err)
	}
	t.Setenv("CGO_ENABLED", "0")
	_, err := compileNative(context.Background(), t.TempDir(), ".text\n")
	if err == nil || !strings.Contains(err.Error(), "CGO_ENABLED=1") {
		t.Fatalf("missing prerequisite diagnostic: %v", err)
	}
}

func TestNativeMissingImplementation(t *testing.T) {
	const globals = "func MOVAllBytesASM(count uint64, data *byte)"
	for _, assembly := range []string{"", " \n\t"} {
		cfg := ExecutionConfig{Globals: globals, Assembly: assembly, Setup: "data := make([]byte, 1024)", Bench: "MOVAllBytesASM(1024, &data[0])"}
		if _, err := BuildExecutionSource(cfg); err == nil || !strings.Contains(err.Error(), "assembly source is required for bodyless function MOVAllBytesASM") {
			t.Fatalf("missing implementation diagnostic: %v", err)
		}
		if _, err := ParseExecutionConfig(ExecutionRequest{Name: "MOV", Assembly: assembly, Code: "#globals\n" + globals + "\n#bench\nMOVAllBytesASM(0, nil)"}); err == nil || !strings.Contains(err.Error(), "assembly source is required") {
			t.Fatalf("missing request validation: %v", err)
		}
	}
	if _, err := BuildExecutionSource(ExecutionConfig{Globals: "func helper() {}", Bench: "helper()"}); err != nil {
		t.Fatalf("ordinary Go helper rejected: %v", err)
	}
}

func TestNativeMOVUserExample(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("NASM requires x64")
	}
	if _, err := exec.LookPath("nasm"); err != nil {
		t.Skip("nasm not installed")
	}
	if output, _ := exec.Command("go", "env", "CGO_ENABLED").Output(); strings.TrimSpace(string(output)) != "1" {
		t.Skip("cgo disabled")
	}
	assembly, err := os.ReadFile("../testdata/native.asm")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseExecutionConfig(ExecutionRequest{Name: "MOV", Assembly: string(assembly), Code: `#imports

#globals
func MOVAllBytesASM(count uint64, data *byte)

#sweep
N: [1024, 4096]

#setup
data := make([]byte, N)

#bench
MOVAllBytesASM(uint64(N), &data[0])

#cleanup
for i, value := range data { if value != byte(i) { panic("incorrect native write") } }
`})
	if err != nil {
		t.Fatal(err)
	}
	cfg.BenchDuration = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	results, err := RunSweep(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].Iterations <= 0 || results[1].Iterations <= 0 {
		t.Fatalf("missing measurements: %+v", results)
	}
}

func TestNativeParameterNamesDoNotShadowBridge(t *testing.T) {
	if err := nativePlatform(); err != nil {
		t.Skip(err)
	}
	if output, _ := exec.Command("go", "env", "CGO_ENABLED").Output(); strings.TrimSpace(string(output)) != "1" {
		t.Skip("cgo disabled")
	}
	assembly, err := os.ReadFile("../testdata/native.S")
	if err != nil {
		t.Fatal(err)
	}
	_, err = RunExecution(context.Background(), ExecutionConfig{Assembly: string(assembly), BenchDuration: time.Millisecond,
		Imports: `_ "unsafe"`,
		Globals: "//go:linkname benchNanotime runtime.nanotime\nfunc benchNanotime() int64\nfunc Add64(C, uint64 uint64) (__bench_asm_unsafe uint64)\nfunc Store64(__bench_asm_unsafe *uint64, C uint64)",
		Setup:   "var result uint64", Bench: "Store64(&result, Add64(1 << 40, 7))", Cleanup: `if result != (1 << 40) + 7 || benchNanotime() <= 0 { panic("incorrect result") }`})
	if err != nil {
		t.Fatal(err)
	}
}

func TestLinkedGoDeclarationsRemainSupported(t *testing.T) {
	const globals = "//go:linkname benchNanotime runtime.nanotime\nfunc benchNanotime() int64"
	if _, err := ParseExecutionConfig(ExecutionRequest{Name: "linked Go", Code: "#imports\n_ \"unsafe\"\n#globals\n" + globals + "\n#bench\n_ = benchNanotime()"}); err != nil {
		t.Fatal(err)
	}
	_, err := RunExecution(context.Background(), ExecutionConfig{Name: "linked Go", BenchDuration: time.Millisecond,
		Imports: `_ "unsafe"`, Globals: globals, Bench: `if benchNanotime() <= 0 { panic("invalid timer") }`})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPlainGoWithoutCGO(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux regression check")
	}
	t.Setenv("CGO_ENABLED", "0")
	t.Setenv("CC", "missing-c-compiler")
	_, err := RunExecution(context.Background(), ExecutionConfig{Name: "plain Go", BenchDuration: time.Millisecond,
		Setup: "values := []int{1,2,3}; result := 0", Bench: "for _, value := range values { result += value }", Cleanup: `if result != 6 { panic("incorrect sum") }`})
	if err != nil {
		t.Fatal(err)
	}
}

func TestNativeNOPVariants(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("NASM requires x64")
	}
	if _, err := exec.LookPath("nasm"); err != nil {
		t.Skip("nasm not installed")
	}
	if output, _ := exec.Command("go", "env", "CGO_ENABLED").Output(); strings.TrimSpace(string(output)) != "1" {
		t.Skip("cgo disabled")
	}
	for _, count := range []int{1, 5, 10} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			assembly := fmt.Sprintf("global NOPLoop\nsection .text\nNOPLoop:\n xor rax,rax\n test rdi,rdi\n jz .done\n.loop:\n times %d nop\n add rax,1\n dec rdi\n jnz .loop\n.done:\n ret\n", count)
			_, err := RunExecution(context.Background(), ExecutionConfig{Assembly: assembly, BenchDuration: time.Millisecond,
				Globals: "func NOPLoop(count uint64) uint64", Bench: `for _, count := range []uint64{0,1024,1000000} { if NOPLoop(count) != count { panic("incorrect loop result") } }`})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
