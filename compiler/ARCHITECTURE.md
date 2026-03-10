# Compiler Architecture

AntLisp compiles S-expression source code to flat Antssembly through a 7-phase
pipeline. Each phase is a separate TypeScript module with well-defined
inputs and outputs.

```
Source → Parse → AST
  → Phase 1: Macro Expansion        (AST → AST)
  → Phase 2: Metadata Collection    (AST → AST + tags)
  → Phase 3: SSA Lowering           (AST → SSA IR)
  → Phase 4: Optimization Passes    (SSA IR → SSA IR)
  → Phase 5: Register Allocation    (SSA IR → allocated IR)
  → Phase 6: Code Generation        (allocated IR → assembly lines)
  → Phase 7: Peephole Optimization  (assembly lines → assembly lines)
```

## Files

| File | Role |
|---|---|
| `antlisp.ts` | Pipeline coordinator and CLI entry point |
| `parse.ts` | Tokenizer, recursive-descent parser, AST types |
| `expand.ts` | Phase 1 — macro expansion, `(const ...)` evaluation, hygienic substitution |
| `metadata.ts` | Phase 2 — collects `(set-tag ...)` directives |
| `ssa.ts` | Phase 3 — lowers AST to SSA IR (basic blocks, phi nodes, terminators) |
| `optimize.ts` | Phase 4 — constant folding, copy propagation, DCE, dead block elimination, comparison rewriting |
| `regalloc.ts` | Phase 5 — linearize blocks, liveness analysis, linear scan register allocator |
| `codegen.ts` | Phase 6 — SSA instructions → assembly text, parallel move resolution for phi copies |
| `peephole.ts` | Phase 7 — dead store elimination, redundant jump removal |

## Supporting files

| File | Role |
|---|---|
| `antlisp.test.js` | End-to-end integration tests |
| `antlisp.unit.js` | Unit test runner for `.unit.alisp` test files |
| `test-helpers.ts` | Shared test harness and pipeline helpers |
| `run.ts` | Simulation runner CLI (assembles + runs against evaluation maps) |
| `node-engine.js` | SWARM VM ported to Node.js |

## Key design decisions

**SSA IR.** The intermediate representation uses static single assignment
form with explicit phi nodes at block join points. This enables clean
optimization passes (constant folding, copy propagation, DCE) that would
be difficult to do on the AST directly.

**Linear scan register allocation.** With only 8 physical registers (r0-r7),
a linear scan allocator is a good fit — it's simple, fast, and produces
good allocations for the small programs this compiler targets.

**Parallel move resolution.** Phi copies at block boundaries can form cycles
(e.g. swap r0↔r1). The code generator detects these cycles and breaks them
using temporary registers, selected from registers not live at block end.

**Hygienic macros.** Macros capture definition-site bindings and freshen
`tagbody` labels at each expansion to prevent name collisions.
