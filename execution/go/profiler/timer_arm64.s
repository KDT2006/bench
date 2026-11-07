#include "textflag.h"

TEXT ·ReadCPUTimer(SB), NOSPLIT, $0-8
	MRS	CNTVCT_EL0, R0 // read the virtual counter
	MOVD	R0, ret+0(FP)
	RET

TEXT ·ReadCPUTimerFrequency(SB), NOSPLIT, $0-8
	MRS	CNTFRQ_EL0, R0 // read the virtual counter frequency in Hz
	MOVD	R0, ret+0(FP)
	RET

// fenced
TEXT ·ReadCPUTimerStartFenced(SB), NOSPLIT, $0-8
	ISB	$0xf // synchronize all preceding instructions
	MRS	CNTVCT_EL0, R0
	ISB	$0xf // prevent following instructions from executing early
	MOVD	R0, ret+0(FP)
	RET

TEXT ·ReadCPUTimerEndFenced(SB), NOSPLIT, $0-8
	ISB	$0xf // synchronize all preceding instructions
	MRS	CNTVCT_EL0, R0 // read the virtual counter
	ISB	$0xf // prevent following instructions from executing early
	MOVD	R0, ret+0(FP)
	RET
