; x64 C ABI: count/first argument in RDI, pointer/second argument in RSI.
global Add64
global Store64
global Twice
global Answer
global MultiNOP
global MOVAllBytesASM
global NOPAllBytesASM
global CMPAllBytesASM
global DECAllBytesASM

section .text

Add64:
    lea rax, [rdi + rsi]
    ret

Store64:
    mov [rdi], rsi
    ret

Twice:
    addsd xmm0, xmm0
    ret

Answer:
    mov eax, 42
    ret

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

MultiNOP:
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
