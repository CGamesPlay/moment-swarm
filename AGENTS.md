# Project overview

We are developing algorithms to solve an ant simulation challenge. The goal is to maximize score on a set of 120 tests. We have 12 maps that we use to practice.

## Challenge

SWARM is an ant colony simulator. You write a single program that controls all
200 ants simultaneously (each ant runs the same program independently). The goal
is to collect as much food as possible within 2000 ticks. Score is the average
food collection ratio across 12 diverse maps, scaled to 0–1000.

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

- ANTLISP.md is the language reference
- ANTLISP-PATTERNS.md is a programming guide with strategies and patterns
- reference.md is the underlying ISA documentation

## Development commands

```bash
argc test example.alisp             # Run official practice maps
argc test example.alisp -o 1000     # Inflated op limit (stall-free ceiling)
argc test example.alisp -m open     # Run only the "open" map type
argc test example.alisp -s 16       # Run a different set of maps
argc test example.alisp --no-debug  # Production mode (DEBUG=0, rejects ABORTs)
```

```bash
argc compile example.alisp             # Print antssembly
argc compile example.alisp --dump-ssa  # Print the internal SSA representation
argc compile example.alisp -D DEBUG=0  # Compile without debugging information
```

```bash
argc unit compiler/antlisp.unit.alisp  # Run specific unit file
argc selftest                          # Run all compiler + program tests
```

## Interactive debugger

Use `argc debug` with the tmux skill to step through ant behavior:

```bash
argc debug programs/example.alisp -m bridge   # Launch debugger on a specific map
```

Key commands: `forward N`, `rewind N`, `break --id 103 --tick 110`, `continue`, `info [ID]`, `map [ID] [ph]`, `list [ADDR]`, `step`, `world`. Use breakpoints to reach a specific ant at a specific tick, then `step` to trace instruction-by-instruction. This is far more effective than adding ad-hoc trace code — a single reproducible scenario (ant ID + tick + position) beats sampling random ants from aggregate test output. See `compiler/debug.ts` for implementation details, and the `tmux` skill for session management.

If you encounter an internal compiler error or compilation bug while working on an alisp program, immediately stop and ask the user for further instructions.

## Agent-User Relationship

The user is suggesting strategies and agent is implementing them. Sometimes the strategies perform worse by some metrics. Sometimes the user points out a problem with an implementation to highlight a bug. In general, push forward rather than walking back. Only revert changes that the user has explicitly asked for, or when you are unable to resolve correctness issues and want to fulfill the user's directions from a clean slate.
