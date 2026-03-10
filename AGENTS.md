# Project overview

## Challenge

- reference.md is the ISA specification
- compiler/node-engine.js is the virtual machine, ported to node.
- compiler/run.ts is a CLI for the above.

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
- compiler/antlisp.ts is the compiler
- compiler/antlisp.test.js is the integration test suite

To compile an alisp file to antssembly, use `argc compile file.alisp`. To compile and test, use `argc test file.alisp`. Same output format as testing the compiled antssembly directly.

The language is very limited, due to only having 8 registers and no stack. We may wish to improve compiler optimizations if it becomes difficult to create the kinds of programs we want to.

The 64-op limit is particularly concerning for our compiled language. The "stalls" display indicates the number of times the op limit was hit during the run, and the tag of each ant when the stall happened. Before optimizing for stalls, verify that stalls are actually causing problems by `argc test file.alisp -o 1000`.

Interestingly, there is no limit on program size. This means that unrolled loops and duplicating code (via macros) results in larger instruction counts but fewer stalls due to fewer JMP instructions. Use this to your advantage.

If you need to modify the compiler, `argc selftest` MUST ALWAYS PASS. No exceptions.

## ISA notes

- SMELL, SNIFF, and SENSE work at a distance of 1 cell only. A wall never has pheremone. Pheremone on the other side of a wall doesn't matter, because it's further than 1 cell away.
- Actions (MOVE, DROP, PICKUP) and the 64-op limit end the ant's tick, but this is invisible to the program: PC advances past the action, all registers are preserved, and execution resumes at the next instruction on the following tick. There is no reset or re-entry — from the program's perspective, actions are ordinary instructions. Code after a MOVE runs normally (on the next tick).
- Hitting the 64-op limit without an action is a "stall" — the ant wastes a tick doing nothing visible. The goal is to reach an action within budget every tick.
- The program restarts automatically if it reaches the end.
- Pheremone decays at a rate of 1 per tick, independently between all channels. The decay happens after all ants mark the cell.

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

## From the user

Do not, ever, decide to revert something the user points out a problem with. Only walk backwards from something the user explicitly asked for if the user subsequently explicitly asks you to do so.
