#include "textflag.h"

TEXT ·ReadCPUTimer(SB), NOSPLIT, $0-8
    RDTSC

    SHLQ $32, DX // move the high-end 32 bits
    ORQ AX, DX // OR the low-end 32 bits
    MOVQ DX, ret+0(FP)
    RET
