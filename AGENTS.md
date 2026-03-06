# Project overview

- ANTLISP.md is the language specification
- antlisp.js is the compiler
- antlisp.test.js is the compiler test suite
- reference.md is the ISA specification

When you modify an alisp file, always compile it with `argc comile file.alist >/dev/null` to check for errors.

## ISA notes

- SMELL, SNIFF, and SENSE work at a distance of 1 cell only. A wall never has pheremone. Pheremone on the other side of a wall doesn't matter, because it's further than 1 cell away.
- The tick ends, preserving registers and PC, after 64 opcodes or one of the actions (MOVE, DROP, etc).
- The program restarts automatically if it reaches the end.
