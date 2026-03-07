# AntLisp v2 — S-Expression Language for Antssembly

A Scheme-like language that compiles to flat Antssembly for the SWARM ant colony challenge.

## What Changed in v2

The original forager program (dead-reckoning + pheromones, ~70 instructions of hand-written assembly) exposed several gaps in v1. v2 fixes them:

- **`let` for all bindings** — use `(let ((var expr)) ...)` for both long-lived state and short-lived locals; registers are freed when the scope exits
- **Compound expression arguments** — `(mark ch_red (* timer 2))` and `(move (+ (random 4) 1))` now work; sub-expressions auto-compile to temp registers
- **Safe unary negation** — `(set! x (- x))` compiles to `MUL x -1` (1 instruction, no temp register)

## Quick Example

```lisp
(let ((dx 0) (dy 0))
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
(const name value)              ; inline constant (no register)
(alias name reg)                ; emit .alias
```

**Tags are automatically allocated** from all `(set-tag name)` calls in the order they first appear in the program (0–7). There is no need to declare tags explicitly.

### Binding & Mutation

```lisp
(let ((dir (sense food))        ; bindings — scoped registers
      (ch  (carrying?)))
  body...)

(set! var expr)                 ; mutate any let variable
```

`let` variables are freed when the scope exits. Place long-lived state
(dead-reckoning, FSM state, etc.) in a `let` that wraps the main loop.

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
(- x)        ; unary negation (MUL -1 when x = dest)
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
(set-tag tagname)                  ; set ant tag for viewer visualization (auto-allocated)
```

### Macros

Macros expand inline at each call site — no CALL/return overhead, no register conflicts.
`defmacro` can appear at the top level or inside a `let` body.

```lisp
;; Define a macro with (defmacro name (params...) body...)
(defmacro wander ()
  (move (+ (random 4) 1)))

(defmacro move-track (dir dx dy)
  (move dir)
  (cond ((= dir 1) (set! dy (- dy 1)))
        ((= dir 2) (set! dx (+ dx 1)))
        ((= dir 3) (set! dy (+ dy 1)))
        ((= dir 4) (set! dx (- dx 1)))))

(let ((dx 0) (dy 0))
  ;; Usage — expands inline
  (wander)                        ; random direction
  (move-track (sense food) dx dy) ; compound expr as param
)
```

**Key properties:**
- **Hygienic**: Free variables in the macro body resolve at the **definition site**, not the call site. A caller's `let` variable with the same name won't accidentally shadow the macro's reference.
- **Parameters**: Evaluated at the call site, then bound by name inside the macro. Variable args alias the caller's register (allowing `set!`); literal/constant args are inlined.
- **Hygienic tags**: `tagbody` tags and `(go ...)` inside macros get freshened at each expansion site to avoid collisions
- **Multi-statement bodies**: All forms in the body are emitted inline

```lisp
;; Macro with internal control flow
(defmacro grab-if-food ()
  (let ((dir (sense food)))
    (when (!= dir 0)
      (move dir)
      (pickup))))

;; Macro with tagbody/go (freshened per expansion)
(defmacro skip-if-carrying ()
  (tagbody
    (when (carrying?)
      (go done))
    (move n)
    done))

;; Safe: two calls get distinct tags
(skip-if-carrying)
(skip-if-carrying)

;; Hygiene example: macro references outer let binding, not caller's inner one
(let ((counter 0))
  (defmacro bump ()
    (set! counter (+ counter 1)))  ; always refers to the outer 'counter'

  (let ((counter 99))
    (bump)))   ; increments outer counter (r0), not inner (r1)
```

### Low-Level Control Flow

```lisp
(tagbody                        ; scoped label block
  tag-name                      ;   bare symbol = label
  (expr ...)                    ;   interleaved code
  (go tag-name))                ;   jump to tag (validated at compile time)

(comment "text")                ; emit ; text
```

`tagbody` tags are scoped — two separate `tagbody` forms with the same
tag name never collide. `(go name)` is validated at compile time and
must refer to a tag in an enclosing `tagbody`. Inside macros, each
expansion gets its own fresh tags automatically.

```lisp
;; Example: manual retry loop using tagbody
(tagbody
  retry
  (let ((dir (sense food)))
    (when (= dir 0)
      (move (+ (random 4) 1))
      (go retry))
    (move dir)
    (pickup)))
```

---

## Register Allocation Strategy

- **Bindings** (`let`): allocated on entry, freed on scope exit; a `let` wrapping the main loop is effectively permanent for the program's lifetime
- **Temps**: allocated by `resolveArg` for compound sub-expressions, freed immediately

With 8 registers (r0-r7), a typical program uses 3–5 for long-lived state and leaves the rest for temporaries.
