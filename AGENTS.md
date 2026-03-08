# Project overview

## Challenge

- reference.md is the ISA specification
- node-engine.js is the virtual machine, ported to node.
- run.js is a CLI for the above.

Testbed usage: `node run.js brain.ant`

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
- antlisp.js is the compiler
- antlisp.test.js is the compiler test suite

To compile an alisp file to antssembly, use `argc compile file.alisp`. To compile and test, use `argc test file.alisp`. Same output format as testing the compiled antssembly directly.

The language is very limited, due to only having 8 registers and no stack. We may wish to improve compiler optimizations if it becomes difficult to create the kinds of programs we want to.

The 64-op limit is particularly concerning for our compiled language. The "stalls" display indicates the number of times the op limit was hit during the run, and the tag of each ant when the stall happened. Before optimizing for stalls, verify that stalls are actually causing problems by `argc test file.alisp -o 1000`.

## ISA notes

- SMELL, SNIFF, and SENSE work at a distance of 1 cell only. A wall never has pheremone. Pheremone on the other side of a wall doesn't matter, because it's further than 1 cell away.
- The tick ends, preserving registers and PC, after 64 opcodes or one of the actions (MOVE, DROP, etc).
- The program restarts automatically if it reaches the end.
- Pheremone decays at a rate of 1 per tick, independently between all channels. The decay happens after all ants mark the cell.

## From the user

Do not, ever, decide to revert something the user points out a problem with. Only walk backwards from something the user explicitly asked for if the user subsequently explicitly asks you to do so.
