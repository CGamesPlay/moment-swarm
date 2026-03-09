# Compiler Optimization Notes

## Done

### Dead branch-chain elimination

Detects chains of `br_cmp` blocks where every branch body is empty and
all paths converge at the same merge block. This pattern arises from
macro expansion (e.g. a `(cond)` dispatch where the bodies are empty)
but the pass is general — it matches any `br_cmp` chain with the same
structure.

**Detection** (SSA pass `deadBranchChainElimination` in `optimize.ts`):
For each block B with a `br_cmp` terminator, check if the then-block is
empty (no instrs, no phis) and jumps to a target T. Walk the else-chain:
each link must either be empty and jump to T, or have a `br_cmp` whose
then-block is also empty and jumps to T. When every path reaches T and T
has no phi differences from chain blocks, replace B's terminator with
`jmp T`. Dead block elimination cleans up the now-unreachable chain
blocks.

## Shortlist (TODO)

### Redundant SET elimination in arithmetic sequences

The codegen for two-operand instructions (ADD, SUB, AND, etc.) emits a
SET to copy the first operand into the destination register before the
operation. When the register allocator has already placed the operand in
the destination, the SET is elided — but when it hasn't, we get chains
like:

    SET r0 r5       ; copy first arg
    AND r0 255      ; operate
    SET r5 r0       ; copy result back (for next use)

The peephole pass eliminates dead stores (SET immediately followed by
SET to the same register), but it can't help when the intermediate
value is actually used. Better register allocation hints or a
post-allocation coalescing pass could eliminate many of these SETs.

## Ruled out

### Branch inversion (JGT+JMP → JLE)

The ISA doesn't have JLE or JGE instructions. The codegen already uses
comparison rewriting to convert `(gt a N)` → `(ge a N+1)` for constant
N, which avoids the trampoline. But for register-register comparisons,
there's no way to invert — the trampoline (conditional skip + JMP) is
the only option.

### Subroutine extraction (dedup via CALL/RET)

The CALL instruction saves the return PC into a register and does an
unconditional jump. RET is just an indirect JMP. There is no stack, so
there are no real function calls — a subroutine would clobber the return
register if it called another subroutine, and there's nowhere to save
it. Code deduplication must happen at the source/macro level, not via
runtime subroutines.
