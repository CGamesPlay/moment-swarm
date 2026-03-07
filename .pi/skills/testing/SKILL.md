---
name: testing
description: antlisp testing skill
---
## Unit testing

Antlisp programs can be unit tested with the `.unit.alisp` format. Run a test file with:

```
argc unit tests.unit.alisp
argc unit tests.unit.alisp --verbose   # also prints assembly and register state
```

Or directly: `node antlisp.unit.js tests.unit.alisp`

Test files contain `(test ...)` blocks. Any top-level forms outside a `(test ...)` block are shared preamble prepended to every test (useful for shared macros or constants).

### Syntax

```
(test "name" [:opt val | :flag]* (begin ...) (assert-*) ...)
```

The `(begin ...)` is the program body. All `(assert-*)` forms come after it, making the boundary between code and checks explicit. `:run-once` implies `:ticks 1` when `:ticks` is not also given.

```lisp
; shared preamble — available to all tests in the file
(defmacro inc! (v) (set! v (+ v 1)))

(test "addition"
  :run-once
  (begin
    (define x 0 :reg r1)
    (set! x (+ x 3)))
  (assert-reg r1 3))

(test "accumulates across ticks"
  :ticks 5
  (begin
    (define total 0 :reg r1)
    (loop
      (set! total (+ total 2))
      (move random)))
  (assert-reg r1 10))
```

### Test options

| Option | Default | Meaning |
|---|---|---|
| `:run-once` | — | Run the program exactly once (stops at PC wrap); implies `:ticks 1` |
| `:ticks N` | 10 | World ticks to simulate |
| `:max-ops N` | 64 | Explicit `maxOpsPerTick` budget |
| `:ants N` | 1 | Number of ants |
| `:ant-x X` / `:ant-y Y` | map centre | Override ant starting position |
| `:place-food X Y` | — | Place one food unit at (X, Y) before running; repeatable |
| `:seed N` | 1 | World RNG seed |
| `:map-size N` | 32 | Map width and height (square) |

### Assertion forms

| Assertion | Meaning |
|---|---|
| `(assert-reg rN value)` | Register rN equals value |
| `(assert-reg rN op value)` | Register rN satisfies op (`=` `!=` `<` `>` `<=` `>=`) |
| `(assert-reg-name varname value)` | Named variable equals value |
| `(assert-reg-name varname op value)` | Named variable satisfies op |
| `(assert-carrying)` | Ant 0 is carrying food |
| `(assert-not-carrying)` | Ant 0 is not carrying food |
| `(assert-food-collected N)` | `world.foodCollected == N` |
| `(assert-food-collected op N)` | `world.foodCollected` satisfies op |
| `(assert-tick N)` | World tick counter equals N |
| `(assert-pc N)` | Ant 0 program counter equals N |
| `(assert-at X Y)` | Ant 0 is at position (X, Y) |

### VM execution model notes

- **Registers persist** across ticks — they are per-ant state, not reset each tick.
- **`(define x val)`** re-runs every time the program wraps back to the start, re-initialising the register. Use `:run-once` to execute the program exactly once and avoid this.
- **`:run-once`** is best for testing pure computation (arithmetic, conditionals, loops). It uses `stepAnt` from the engine with a stop-at-wrap sentinel, so it is running the real VM, not a reimplementation.
- **Multi-tick accumulation** works naturally with `(loop ... (move random))`: each MOVE ends the tick cleanly, registers survive, and the loop body runs once per tick.
