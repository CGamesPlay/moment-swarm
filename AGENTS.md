# Project overview

We are developing algorithms to solve an ant simulation challenge. The goal is to maximize score on a set of 120 tests. We have 12 maps that we use to practice.

## Challenge

Runs the training dataset using the given antssembly file. Prints a per-map score and a total score.

Example baseline using the example brain.ant file:

```
Assembled 70 instructions
  chambers-3lc8x4             21/ 1044  (  2.0%)        0 stalls  88ms
  bridge-1u7xlw                0/  673  (  0.0%)        0 stalls  61ms
  gauntlet-41jczs              0/ 1315  (  0.0%)        0 stalls  61ms
  islands-3ekzho               0/  852  (  0.0%)        0 stalls  64ms
  open-38bs6g                152/ 1140  ( 13.3%)        0 stalls  62ms
  brush-3c3sbo                 0/  676  (  0.0%)        0 stalls  64ms
  prairie-pgwqb              224/  724  ( 30.9%)        0 stalls  63ms
  field-hjbev                 71/  955  (  7.4%)        0 stalls  63ms
  pockets-1545v7               0/ 1001  (  0.0%)        0 stalls  66ms
  fortress-2wwxqn              0/ 1256  (  0.0%)        0 stalls  61ms
  maze-r4177                   0/ 1189  (  0.0%)        0 stalls  62ms
  spiral-zu9av                39/  964  (  4.0%)        0 stalls  63ms

Score: 48/1000  (4.8% avg collection, 12 maps, 0 stalls, 778ms)
```

## Custom language

We've built Antlisp, a lisp-based language specifically to solve this challenge.

- ANTLISP.md is the language specification
- ANTLISP-PATTERNS.md is a programming guide for the lanugage
- reference.md is the underlying ISA documentation

The key things to note:
- The target machine has 8 registers, no stack, a 64-instruction limit per "tick", and no limit on program size.
- Since there's no call/return mechanism, macros are the only form of code reuse — they expand inline at every call site. Use `dotimes`/`dolist` for unrolled loops and callback-style macro parameters for reusable control flow.
- Actions (`move`, `pickup`, `drop`) end the ant's turn but don't reset the program counter — execution resumes at the next instruction on the next tick. Bookkeeping after a move runs normally.
- Scope variables to the states where they're needed. Variables with non-overlapping lifetimes share the same physical register automatically via liveness analysis. Don't manually reuse registers; let the compiler do it.
- Use `argc test file.alisp -o 1000` to test with an inflated op limit. If the score barely changes, the algorithm is the bottleneck — not op efficiency or stalls.
- `--no-debug` causes the assembler to reject any `ABORT` opcode, acting as a production safety check that fails loudly if a debug guard was accidentally omitted.
- The simulator is fully deterministic. Small score differences (±5-10 points) from pure refactoring are real but reflect code-layout effects on op budget, not algorithmic changes — don't chase them.

## Development commands

The most common command is to run the test suite on a given alisp file. By default, it runs the same tests as the official practice maps. It can be overridden with parameters:

```bash
argc test example.alisp             # Run official practice maps
argc test example.alisp -o 1000     # Run official practice maps with artifically increased op limit
argc test example.alisp -m open     # Run only the "open" map type
argc test example.alisp -s 16       # Run a different set of maps
argc test example.alisp --no-debug  # Set DEBUG=0 and disable ABORT opcode (production mode)
```

You may with to inspect the output of a program:

```bash
argc compile example.alisp             # Print antssembly
argc compile example.alisp --dump-ssa  # Print the internal SSA representation
argc compile example.alisp -D DEBUG=0  # Compile without debugging information
```

You can also run alisp unit tests:

```bash
argc unit compiler/antlisp.unit.alisp # Run specific unit file
```

To run compiler tests (required when modifying the compiler). This runs all internal compiler tests, then re-validates all program tests and compiles all 

```bash
argc selftest
```

If you encounter an internal compiler error or compilation bug while working on an alisp program, immediately stop and ask the user for further instructions.

## Agent-User Relationship

The user is suggesting strategies and agent is implementing them. Sometimes the strategies perform worse by some metrics. Sometimes the user points out a problem with an implementation to highlight a bug. In general, push forward rather than walking back. Only revert changes that the user has explicitly asked for, or when you are unable to resolve correctness issues and want to fulfill the user's directions from a clean slate.
