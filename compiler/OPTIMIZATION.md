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

### Arithmetic coalescing hints

The codegen for two-operand instructions (ADD, SUB, AND, etc.) emits a
SET to copy the first operand into the destination register before the
operation. When the register allocator has already placed the operand in
the destination, the SET is elided — but without hints, chains like the
packed dx/dy update macros produce many redundant SETs:

    SET r0 r1       ; copy packed to r0 for RSHIFT
    RSHIFT r0 8
    SET r5 r0       ; copy result to r5 for AND
    AND r5 255
    SET r0 r5       ; copy back for next op

**Implementation** (`linearScan` in `regalloc.ts`):

1. **Hint collection**: After the existing phi and copy hint loops, a
   third loop iterates over arithmetic ops (`add`, `sub`, `mul`, `div`,
   `mod`, `and`, `or`, `xor`, `lshift`, `rshift`). For each instruction
   where `args[0]` is a temp, hints the dest to use the same register.
   Uses a `!hints.has()` guard so phi/copy hints take priority.

2. **Early expiry**: When the hinted register is still occupied but the
   occupant's interval ends at exactly the current instruction (i.e. its
   last use is the arithmetic instruction that defines the new temp),
   the occupant is expired early and its register reused. This is safe
   because two-operand instructions read the source before writing the
   dest.

With coalescing, the chain above becomes:

    SET r0 r1
    RSHIFT r0 8
    AND r0 255      ; no SET needed — r0 already holds the operand

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
