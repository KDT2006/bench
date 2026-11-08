# Native assembly benchmarks

Open a lane's **native.asm** (x64) / **native.S** (ARM64) tab and choose **Load NOP
example** to load MOV, NOP, CMP and DEC routines, matching Go/Python declarations
and a sweep in code mode. The NOP loop is selected in `#bench`; change that call
to choose another routine. Assembly is retained
in autosave, run snapshots, duplication, workspace JSON and raw-file ZIP exports.

The optional `assembly` request field is separate from directive-separated
`code`. Both have a **65,536 Unicode character** limit, enforced by the frontend,
proxy and executors. NUL characters are rejected; the 1 MiB JSON body limit still
applies. Empty/omitted assembly uses the ordinary execution path.

## Go skeletons

```go
#globals
func MultiNOP(count uint64)
func Add64(a, b uint64) uint64
func Store64(destination *uint64, value uint64)

#setup
var result uint64

#bench
MultiNOP(1024)
Store64(&result, Add64(2, 3))

#cleanup
if result != 5 { panic("incorrect native result") }
```

Bodyless functions become typed cgo calls to exported assembly symbols. Helpers
with Go bodies remain Go functions. Name all parameters. Supported types:
`int8/16/32/64`, `uint8/16/32/64`, `int`, `uint`, `uintptr`, `byte`, `rune`,
`float32/64` and pointers to those scalar types. Return one value or no value.
Slices, strings, structs, callbacks, methods, generics, variadics and multiple
returns are unsupported. Pass a buffer as a pointer plus a length. Follow
[cgo pointer rules](https://go.dev/cmd/cgo/#hdr-Passing_pointers); assembly must
not retain Go pointers after returning.

## Python skeletons

```python
#imports
import ctypes

#globals
def MultiNOP(count: ctypes.c_uint64) -> None: ...
def Add64(a: ctypes.c_uint64, b: ctypes.c_uint64) -> ctypes.c_uint64: ...
def Store64(destination: ctypes.POINTER(ctypes.c_uint64), value: ctypes.c_uint64) -> None: ...

#setup
result = ctypes.c_uint64()

#bench
MultiNOP(1024)
Store64(ctypes.byref(result), Add64(2, 3))

#cleanup
assert result.value == 5
```

Typed `pass` or ellipsis stubs become `ctypes.CDLL` functions with explicit
`argtypes` and `restype`; the library loads in the benchmark child. Annotations
accept ctypes numeric types, `c_void_p`, and `POINTER(type)`, qualified with
`ctypes.` or imported by name. `int` maps to `c_ssize_t`, `float` to `c_double`.
Always specify the return type, using `None` for void. Decorators, defaults,
keyword-only/variadic arguments and async stubs are unsupported. Helpers with
bodies remain Python functions. See [ctypes function prototypes](https://docs.python.org/3/library/ctypes.html#specifying-the-required-argument-types-function-prototypes).

## Toolchain, syntax and ABI

Executors support their native **x64 or ARM64** architecture on Linux/macOS.
Both need GCC or Clang, plus `nasm` for NASM sources; Go also requires `CGO_ENABLED=1`. Go uses `go env CC`;
Python uses `CC` or `cc`. Frontend compiler options still control Go builds or
Python interpretation; `-asmflags` controls the Go assembler, not native `.S`.

The default x64 example uses **NASM syntax**: `global`, `section .text`, `db`,
semicolon comments, and scoped local labels like `.loop`. The executor detects
NASM directives (`global`, `section`, `bits`, `%define`, etc.) and invokes NASM
with `elf64` on Linux or `macho64` on macOS. macOS symbol prefixes and Linux
stack metadata are handled by the executor; user sources need no platform macros.
NASM requires an x64 executor and is not used for ARM64.

For example, this source works on either x64 host:

```asm
global NOPAllBytesASM
section .text

NOPAllBytesASM:
    test rdi, rdi
    jz .done
    xor rax, rax
.loop:
    db 0x0f, 0x1f, 0x00 ; one 3-byte NOP
    inc rax
    cmp rax, rdi
    jb .loop
.done:
    ret
```

The executor uses NASM's [object formats and symbol prefix option](https://www.nasm.us/doc/nasm02.html)
to handle platform differences. Write C function names without a leading
underscore in NASM; it is added on macOS. Use relative addressing for static
data (e.g. `default rel`) when linking into Python's shared library.

Existing GNU/Clang native assembly, preprocessed as `.S`, remains supported.
On x64 use AT&T syntax or `.intel_syntax noprefix` for Intel syntax; ARM64 uses
GNU/Clang AArch64 instructions. ARM64 examples are generated for the selected OS,
so their exported names have a leading underscore on macOS and no platform macros.
Inline assembly, Go Plan 9 syntax (`TEXT`,
`NOSPLIT`, `SB`, `FP`) and ARM32 are unsupported.

On x64 integer arguments begin in RDI, RSI, RDX, RCX, R8, R9 and results use RAX.
On ARM64 integer arguments begin in X0–X7 and results use X0. Follow the host ABI
for FP registers and stack arguments. Preserve callee-saved registers and stack
alignment, return normally, and use position-independent addressing.

For custom GNU/Clang `.S` sources, macOS C symbols need a leading underscore.
The ARM64 example generates it directly. A hand-written source intended for
multiple platforms can optionally use preprocessing:

```asm
#ifdef __APPLE__
#define SYMBOL(name) _##name
#else
#define SYMBOL(name) name
#endif
.text
.globl SYMBOL(Add64)
SYMBOL(Add64):
#if defined(__x86_64__)
    leaq (%rdi,%rsi), %rax
#else
    add x0, x0, x1
#endif
    ret
#ifdef __linux__
.section .note.GNU-stack,""
#endif
```

The [GNU/Clang fixture](testdata/native.S) includes NOP loops, integer, pointer,
floating-point and no-argument functions for both architectures. The
[NASM fixture](testdata/native.asm) tests x64, including MOV buffer writes and
repeated local label names across functions. Both loop examples handle zero
counts without running or touching memory. Windows examples that pass count in
RCX and data in RDX must be adapted to RDI and RSI on Linux/macOS; NASM object
format selection changes symbol names and encoding, not the calling convention.

cgo/ctypes call overhead is included in the measured region. Put repetition
loops inside assembly to amortize it for short instructions. Compilation and
library loading happen before measurement. Each sweep combination gets its own
temporary build, removed after execution; compiler/linker and missing-symbol
errors flow through the run log.

## Validation

Run `go test -run TestNative -v` from `execution/go` and
`python3 -m unittest execution.py.tests.test_assembly -v` from the repo root.
These compile and execute the fixture on the current host, checking 64-bit
values, pointer writes, FP values, multiple functions, zero-count NOPs and sweeps.
Run on each target host to validate its ABI and toolchain.
