// Shared native C ABI fixture: same exported functions on all supported hosts.
#ifdef __APPLE__
#define SYMBOL(name) _##name
#else
#define SYMBOL(name) name
#endif
.text
.globl SYMBOL(Add64)
.globl SYMBOL(Store64)
.globl SYMBOL(Twice)
.globl SYMBOL(Answer)
.globl SYMBOL(MultiNOP)
#if defined(__x86_64__)
.intel_syntax noprefix
SYMBOL(Add64):
    lea rax, [rdi+rsi]
    ret
SYMBOL(Store64):
    mov [rdi], rsi
    ret
SYMBOL(Twice):
    addsd xmm0, xmm0
    ret
SYMBOL(Answer):
    mov eax, 42
    ret
SYMBOL(MultiNOP):
    test rdi, rdi
    jz .Ldone
    xor eax, eax
.Lloop:
    .byte 0x0f, 0x1f, 0x00
    inc rax
    cmp rax, rdi
    jb .Lloop
.Ldone:
    ret
#elif defined(__aarch64__) || defined(__arm64__)
.p2align 2
SYMBOL(Add64):
    add x0, x0, x1
    ret
SYMBOL(Store64):
    str x1, [x0]
    ret
SYMBOL(Twice):
    fadd d0, d0, d0
    ret
SYMBOL(Answer):
    mov x0, #42
    ret
SYMBOL(MultiNOP):
    cbz x0, .Ldone
    mov x9, #0
.Lloop:
    nop
    add x9, x9, #1
    cmp x9, x0
    b.lo .Lloop
.Ldone:
    ret
#else
#error Unsupported native assembly architecture
#endif
#ifdef __linux__
.section .note.GNU-stack,""
#endif
