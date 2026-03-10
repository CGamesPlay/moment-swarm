# AntLisp — S-Expression Language for Antssembly

A Scheme-like language that compiles to flat Antssembly for the SWARM ant colony challenge.

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
argc compile program.alisp                        # compile to stdout
argc compile program.alisp > out.asm              # save to file
argc compile -D EXPLORE_TIMEOUT=400 program.alisp # override a const
```

### Const overrides (`-D`)

Any `(const name value)` declared in the source can be overridden from the
command line with `-D NAME=VALUE`. This is useful for hyperparameter sweeps
without editing the source file.

```bash
# Single override
argc test bridge.alisp -D EXPLORE_TIMEOUT=400

# Multiple overrides
argc test bridge.alisp -D EXPLORE_TIMEOUT=400 -D TRAIL_STRENGTH=80

# Channel/direction values work too
argc compile forager.alisp -D EXPLORING_PH=ch_blue
```

Rules:
- The const **must be declared** in the source with `(const NAME ...)` — overrides
  do not inject new consts.
- A warning is printed to stderr if a `-D` name doesn't match any `(const ...)` in
  the source (catches typos).
- Numeric strings are parsed as numbers; everything else is treated as a
  symbol (channel/direction names are uppercased automatically).

### Conversion to SSA

When diagnosing register exhaustion, it can be useful to output the optimized SSA form of the program.

```bash
argc compile --dump-ssa file.alisp
```

---

## Language Reference

### Top-Level Forms

```lisp
(const name value)              ; inline constant (no register)
(alias name reg)                ; emit .alias
(include "path.inc.alisp")      ; import macros/consts from file
```

**Tags are automatically allocated** from all `(set-tag name)` calls in the order they first appear in the program (0–7). There is no need to declare tags explicitly.

### Binding & Mutation

```lisp
(let ((x 10) (y x))            ; parallel: all inits eval before binding
  body...)                      ;   y sees outer x, not the x=10 being bound

(let* ((x 1) (y (+ x 1)))      ; sequential: each init sees prior bindings
  body...)                      ;   y sees x=1 from the same block

(set! var expr)                 ; mutate any let variable
```

`let` evaluates all init expressions in the enclosing scope, then binds
all names at once. `let*` evaluates and binds sequentially, so later
bindings can refer to earlier ones in the same block. Both scope their
variables — names are freed when the block exits. `set!` mutations to
outer variables propagate through both forms.

Place long-lived state (dead-reckoning, FSM state, etc.) in a `let`
that wraps the main loop.

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
(dolist (x (values 1 2 3)) body...) ; iterate over constant values
(break)                         ; exit innermost loop
(continue)                      ; restart innermost loop
```

`dotimes` with a compile-time constant count is fully unrolled — each
iteration becomes straight-line code with no loop overhead. When the
count is a runtime value, the compiler falls back to a normal loop.
`break` and `continue` work in both cases.

```lisp
;; Break exits early
(let ((count 0))
  (dotimes (i 10)
    (set! count (+ count 1))
    (when (= count 3) (break))))  ; count = 3
```

`dolist` iterates a variable over a list of compile-time constant values.
All values must be literals or const-resolvable expressions. The loop body
is fully unrolled — each iteration becomes straight-line code with no
loop overhead. `break` and `continue` work as expected.

```lisp
;; Sum specific values
(let ((sum 0))
  (dolist (x (values 10 20 30))
    (set! sum (+ sum x))))    ; sum = 60

;; Skip a value with continue
(let ((sum 0))
  (dolist (x (values 1 2 3 4 5))
    (when (= x 3) (continue))
    (set! sum (+ sum x))))    ; sum = 12 (skips 3)
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

### Actions

```lisp
(move n)  (move (+ (random 4) 1))  ; compound expressions OK
(pickup)  (drop)
(mark ch_red (* timer 2))          ; compound amount OK
(set-tag tagname)                  ; set ant tag for viewer visualization (auto-allocated)
```

**Tick model**: `move`, `pickup`, and `drop` are "actions" that end the
ant's tick — but this is purely a scheduling detail. From the program's
perspective these are ordinary instructions: the program counter advances
past them, registers are preserved, and execution resumes at the very
next instruction on the following tick. There is no reset, no re-entry,
no observable discontinuity. The only effect is that other ants get a
turn and pheromones decay between ticks.

A tick also ends if 64 ops execute without hitting an action (a "stall").
Stalls are wasteful because the ant does nothing visible that tick.
The op budget resets each tick, so the goal is to reach an action within
64 ops every tick.

Code that follows an action runs normally on the next tick — it is fine
to place bookkeeping (e.g. updating a displacement tracker) after a
`(move ...)` and before looping back, and macros can contain actions
internally without any special handling.

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

### Includes

`(include "path")` imports macro and const definitions from another file,
enabling shared libraries without copy-paste.

```lisp
;; macros.inc.alisp — shared library
(const TRAIL_STRENGTH 80)
(defmacro wander () (move (+ (random 4) 1)))

;; program.alisp — uses the library
(include "macros.inc.alisp")
(loop
  (mark ch_red TRAIL_STRENGTH)
  (wander))
```

**Path resolution**: include paths are relative to the file containing the
`(include ...)` form. The compiler CLI and unit test runner provide the
source file path automatically.

**Allowed forms**: included files may only contain `const`, `defmacro`,
`comment`, and `include`. Any code form (e.g. `move`, `if`, `let`) in an
included file causes a compile error. This keeps includes purely
declarative — they define reusable building blocks, not executable code.

**Transitive includes**: included files can include other files. A cycle
detection check prevents circular includes.

```lisp
;; base.inc.alisp
(const BASE_TIMEOUT 200)

;; derived.inc.alisp — builds on base
(include "base.inc.alisp")
(const EXPLORE_TIMEOUT (+ BASE_TIMEOUT 100))

;; program.alisp — gets both
(include "derived.inc.alisp")  ; BASE_TIMEOUT=200, EXPLORE_TIMEOUT=300
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

## Compiler Optimizations

The compiler performs several optimization passes on the SSA intermediate
representation before register allocation:

- **Constant folding** — evaluates arithmetic on compile-time constants and
  eliminates branches with known conditions.
- **Copy propagation** — removes trivial register-to-register copies, following
  chains to their source.
- **Dead code elimination** — removes unused temporaries and phi nodes, respecting
  side effects (sensing and actions are never eliminated).
- **Dead block elimination** — removes unreachable basic blocks and cleans up
  phi entries that reference them.
- **Comparison rewriting** — converts `gt N` → `ge N+1` and `lt N` → `le N-1`
  to match the assembly's comparison operators (`<=`, `>=`, `==`, `!=`).

After code generation, a peephole pass removes dead stores (consecutive `SET` to
the same register) and redundant jumps (jump to the immediately following label).

---

## Register Allocation Strategy

- **Bindings** (`let`/`let*`): allocated on entry, freed on scope exit; a `let` wrapping the main loop is effectively permanent for the program's lifetime
- **Temps**: allocated by `resolveArg` for compound sub-expressions, freed immediately

With 8 registers (r0-r7), a typical program uses 3–5 for long-lived state and leaves the rest for temporaries.
