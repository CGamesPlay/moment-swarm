# AntLisp v2 — S-Expression Language for Antssembly

A Scheme-like language that compiles to flat Antssembly for the SWARM ant colony challenge.

## What Changed in v2

The original forager program (dead-reckoning + pheromones, ~70 instructions of hand-written assembly) exposed several gaps in v1. v2 fixes them:

- **`(define var expr :reg rN)`** — pin globals to specific registers
- **Compound expression arguments** — `(mark ch_red (* timer 2))` and `(move (+ (random 4) 1))` now work; sub-expressions auto-compile to temp registers
- **Safe unary negation** — `(set! x (- x))` correctly uses a temp when operand = dest register

## Quick Example

```lisp
(define dx 0 :reg r1)
(define dy 0 :reg r2)

(main
  (loop
    (let ((food (sense food)))
      (if (!= food 0)
        (begin
          (move food)
          (cond ((= food 1) (set! dy (- dy 1)))
                ((= food 2) (set! dx (+ dx 1)))
                ((= food 3) (set! dy (+ dy 1)))
                ((= food 4) (set! dx (- dx 1))))
          (pickup))
        (move (+ (random 4) 1))))))
```

## Usage

```bash
node antlisp.js program.alisp           # compile to stdout
node antlisp.js program.alisp > out.asm # save to file
```

---

## Language Reference

### Top-Level Forms

```lisp
(define var expr)               ; global, auto-allocated register
(define var expr :reg r3)       ; global, pinned to r3
(define-role name id)           ; emit .tag directive
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

`define` variables are global — visible everywhere.
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

## Register Allocation Strategy

- **Globals** (`define`): permanently reserved, never freed
- **Locals** (`let`): allocated on entry, freed on scope exit
- **Temps**: allocated by `resolveArg` for compound sub-expressions, freed immediately

With 8 registers (r0-r7), you have plenty of room for globals and locals.
