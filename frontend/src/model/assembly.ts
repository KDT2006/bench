import type { Arch, Lang, Lane } from "../api/types";
import { assembleSections } from "./sections";

export const SOURCE_CHAR_LIMIT = 65536;
export const sourceLength = (text: string) => Array.from(text).length;
export function sourceIssue(text: string, field: string) {
  if (sourceLength(text) > SOURCE_CHAR_LIMIT) return `${field} must be at most ${SOURCE_CHAR_LIMIT.toLocaleString("en-US")} characters.`;
  if (text.includes("\0")) return `${field} must not contain NUL characters.`;
}

export type AssemblyFile = "native.asm" | "native.S";
export function assemblyFile(lane: Lane): AssemblyFile {
  // A newly created empty tab must not hide a saved implementation in the other format.
  if (lane.files["native.asm"]?.trim()) return "native.asm";
  if (lane.files["native.S"]?.trim()) return "native.S";
  if (lane.files["native.asm"] !== undefined) return "native.asm";
  if (lane.files["native.S"] !== undefined) return "native.S";
  return lane.arch === "x86_64" ? "native.asm" : "native.S";
}
export const assemblySource = (lane: Lane) => lane.files[assemblyFile(lane)] ?? "";

export function assemblyExample(language: Lang, arch: Arch, os = "linux") {
  const code = assembleSections({
    globals: language === "go" ? `func MOVAllBytesASM(count uint64, data *byte)
func NOPAllBytesASM(count uint64)
func CMPAllBytesASM(count uint64)
func DECAllBytesASM(count uint64)` : `def MOVAllBytesASM(count: ctypes.c_uint64, data: ctypes.POINTER(ctypes.c_uint8)) -> None: ...
def NOPAllBytesASM(count: ctypes.c_uint64) -> None: ...
def CMPAllBytesASM(count: ctypes.c_uint64) -> None: ...
def DECAllBytesASM(count: ctypes.c_uint64) -> None: ...`,
    imports: language === "go" ? "" : "import ctypes",
    sweep: "N: [1024, 4096]",
    bench: language === "go" ? "NOPAllBytesASM(uint64(N))" : "NOPAllBytesASM(N)",
  });
  const assembly = arch === "x86_64" ? `; x64 C ABI (Linux/macOS): RDI = count, RSI = data pointer.
global MOVAllBytesASM
global NOPAllBytesASM
global CMPAllBytesASM
global DECAllBytesASM

section .text

MOVAllBytesASM:
    test rdi, rdi
    jz .done
    xor rax, rax
.loop:
    mov [rsi + rax], al
    inc rax
    cmp rax, rdi
    jb .loop
.done:
    ret

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

CMPAllBytesASM:
    test rdi, rdi
    jz .done
    xor rax, rax
.loop:
    inc rax
    cmp rax, rdi
    jb .loop
.done:
    ret

DECAllBytesASM:
    test rdi, rdi
    jz .done
.loop:
    dec rdi
    jnz .loop
.done:
    ret
` : `// ARM64 C ABI: X0 = count, X1 = data pointer.
.text
.globl ${os === "darwin" ? "_" : ""}MOVAllBytesASM
.globl ${os === "darwin" ? "_" : ""}NOPAllBytesASM
.globl ${os === "darwin" ? "_" : ""}CMPAllBytesASM
.globl ${os === "darwin" ? "_" : ""}DECAllBytesASM

${os === "darwin" ? "_" : ""}MOVAllBytesASM:
    cbz x0, .Lmov_done
    mov x9, #0
.Lmov_loop:
    strb w9, [x1, x9]
    add x9, x9, #1
    cmp x9, x0
    b.lo .Lmov_loop
.Lmov_done:
    ret

${os === "darwin" ? "_" : ""}NOPAllBytesASM:
    cbz x0, .Lnop_done
    mov x9, #0
.Lnop_loop:
    nop
    add x9, x9, #1
    cmp x9, x0
    b.lo .Lnop_loop
.Lnop_done:
    ret

${os === "darwin" ? "_" : ""}CMPAllBytesASM:
    cbz x0, .Lcmp_done
    mov x9, #0
.Lcmp_loop:
    add x9, x9, #1
    cmp x9, x0
    b.lo .Lcmp_loop
.Lcmp_done:
    ret

${os === "darwin" ? "_" : ""}DECAllBytesASM:
    cbz x0, .Ldec_done
.Ldec_loop:
    subs x0, x0, #1
    b.ne .Ldec_loop
.Ldec_done:
    ret
`;
  const file: AssemblyFile = arch === "x86_64" ? "native.asm" : "native.S";
  return { code, assembly, file };
}
