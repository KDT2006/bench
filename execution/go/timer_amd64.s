#include "textflag.h"

TEXT ·ReadCPUTimer(SB), NOSPLIT, $0-8
    RDTSC

    SHLQ $32, DX // move the high-end 32 bits
    ORQ AX, DX // OR the low-end 32 bits
    MOVQ DX, ret+0(FP)
    RET

TEXT ·ReadCPUTimerFrequency(SB), NOSPLIT, $0-8
    MOVQ $0, ret+0(FP) // RDTSC frequency must be calibrated
    RET

// fenced
TEXT ·ReadCPUTimerStartFenced(SB), NOSPLIT, $0-8
    LFENCE // wait for all prev instructions to finish
    RDTSC
    LFENCE // wait for RDTSC to finish

    SHLQ $32, DX // move the high-end 32 bits
    ORQ AX, DX // OR the low-end 32 bits
    MOVQ DX, ret+0(FP)
    RET

TEXT ·ReadCPUTimerEndFenced(SB), NOSPLIT, $0-8
    RDTSCP // wait for all prev instructions to finish
    LFENCE

    SHLQ $32, DX
    ORQ AX, DX
    MOVQ DX, ret+0(FP)
    RET
