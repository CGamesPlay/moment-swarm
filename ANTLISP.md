# AntLisp v2 — S-Expression Language for Antssembly

A Scheme-like language that compiles to flat Antssembly for the SWARM ant colony challenge.

## What Changed in v2

The original forager program (dead-reckoning + pheromones, ~70 instructions of hand-written assembly) exposed several gaps in v1. v2 fixes them:

- **`(define var expr :reg rN)`** — pin globals to specific registers, visible inside `defun`
- **`defun` return values** — last expression left in `r0`, caller can bind the result
- **Functions see globals** — `defun` bodies can `set!` top-level `define` variables
- **Compound expression arguments** — `(mark ch_red (* timer 2))` and `(move (+ (random 4) 1))` now work; sub-expressions auto-compile to temp registers
- **Safe unary negation** — `(set! x (- x))` correctly uses a temp when operand = dest register

## Quick Example

```lisp
(define dx 0 :reg r1)
(define dy 0 :reg r2)

(defun move-track (dir)
  (move dir)
  (cond ((= dir 1) (set! dy (- dy 1)))
        ((= dir 2) (set! dx (+ dx 1)))
        ((= dir 3) (set! dy (+ dy 1)))
        ((= dir 4) (set! dx (- dx 1)))))

(main
  (loop
    (let ((food (sense food)))
      (if (!= food 0)
        (begin (move-track food) (pickup))
        (move-track (+ (random 4) 1))))))
```

## Usage

```bash
node antlisp.js program.alisp           # compile to stdout
node antlisp.js program.alisp > out.asm # save to file
node antlisp.js                         # run 13-test suite
```

---

## Language Reference

### Top-Level Forms

```lisp
(define var expr)               ; global, auto-allocated register
(define var expr :reg r3)       ; global, pinned to r3
(define-role name id)           ; emit .tag directive
(defun name (params) body...)   ; subroutine (return val in r0)
(main body...)                  ; entry point
(const name value)              ; emit .const
(alias name reg)                ; emit .alias
```

### Binding & Mutation

```lisp
(let ((dir (sense food))        ; local bindings (scoped registers)
      (ch  (carrying?)))
  body...)

(set! var expr)                 ; mutate any define or let variable
```

`define` variables are global — visible everywhere including inside `defun`.
`let` variables are local — freed when the scope exits.

### Control Flow

```lisp
(if cond then else?)            ; conditional (else optional)
(when cond body...)             ; execute if true
(unless cond body...)           ; execute if false
(cond                           ; multi-branch
  ((= x 1) action-1)
  ((= x 2) action-2)
  (else    default))
(begin expr...)                 ; sequence
```

### Loops

```lisp
(loop body...)                  ; infinite (use break to exit)
(while cond body...)            ; conditional
(dotimes (i 10) body...)        ; counted (i = 0..9)
(break)                         ; exit innermost loop
(continue)                      ; restart innermost loop
```

### Functions

```lisp
(defun wander () (move random))

(defun home-dir ()              ; returns last expression in r0
  (if (> abs-y abs-x)
    (if (> dy 0) 1 3)           ; N=1, S=3
    (if (> dx 0) 4 2)))         ; W=4, E=2

(defun move-track (dir)         ; params passed in registers
  (move dir)
  (cond ...))                   ; can set! globals

; Calling:
(move-track (sense food))       ; implicit call by name
(let ((d (home-dir)))           ; bind return value
  (move-track d))
```

Return convention: last expression -> r0. Return address -> r7 (via CALL/JMP r7).

### Comparisons

```lisp
(= a b)   (!= a b)   (> a b)   (< a b)
(>= a b)  (<= a b)   (zero? x) (not cond)
```

In `if`/`when`/`unless` these compile directly to conditional jumps.
In `let` bindings they materialize as 0/1 values.

### Arithmetic

```lisp
(+ a b c)    ; chained: a + b + c
(- x)        ; unary negation (safe when x = dest)
(* a b)  (/ a b)  (mod a b)  (random n)
(and a b) (or a b) (xor a b)
(lshift a n) (rshift a n)
```

Sub-expressions work as operands: `(+ x (random 4))`, `(* timer 2)`.

### Sensing

```lisp
(sense food)  (sense wall)  (sense nest)  (sense ant)
(smell ch_red)              ; strongest pheromone direction
(sniff ch_red n)            ; intensity 0-255
(probe n)                   ; cell type at direction
(carrying?)                 ; 1 if holding food
(id)                        ; ant index 0-199
```

### Actions (end tick)

```lisp
(move n)  (move (+ (random 4) 1))  ; compound expressions OK
(pickup)  (drop)
(mark ch_red (* timer 2))          ; compound amount OK
(tag 0)
```

### Role Dispatch

```lisp
(define-role forager 0)
(define-role scout 1)
(dispatch (mod (id) 2)
  (forager body...)
  (scout body...))
```

### Low-Level Escape Hatches

```lisp
(label my-label)                ; emit a label
(goto my-label)                 ; JMP to label
(comment "text")                ; emit ; text
```

---

## Compilation Overhead

The forager test case compiles to ~87 instructions vs ~70 hand-written.
The ~24% overhead comes from structured `>` comparisons (no native JLE/JGE
means extra skip labels) and a couple of redundant register moves at
function call boundaries. Both are targets for a future peephole optimizer.

## Register Allocation Strategy

- **Globals** (`define`): permanently reserved, never freed
- **Locals** (`let`): allocated on entry, freed on scope exit
- **Function params**: auto-assigned to first available non-global registers
- **Return value**: always `r0`
- **Return address**: always `r7`
- **Temps**: allocated by `resolveArg` for compound sub-expressions, freed immediately

With 8 registers, 2 reserved (r0 for return, r7 for call), and up to 3
globals, you get 3-6 simultaneous locals depending on complexity.
