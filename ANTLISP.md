# AntLisp — S-Expression Language for Antssembly

A Scheme-like language that compiles to flat Antssembly for the SWARM ant colony challenge.

## The Challenge

SWARM is an ant colony simulator. You write a single program that controls all
200 ants simultaneously (each ant runs the same program independently). The goal
is to collect as much food as possible within 2000 ticks.

**Key constraints:**
- **8 registers** (r0–r7) per ant, persisted across ticks
- **64-op budget** per tick — reaching an action (move/pickup/drop) ends the tick
- **No global communication** — ants share state only through pheromones on the map
- **No absolute positioning** — ants sense only their 4 cardinal neighbors
- Score is the average food collection ratio across 12 diverse maps

**Scoring**: each map has a `totalFood` count. Your score is
`(foodCollected / totalFood)` averaged across all evaluation maps, scaled to
0–1000. A score of 500+ is decent; 700+ is competitive.

### Map types

Programs are evaluated across 12 randomly selected maps from these generators:

| Map | Description |
|-----|-------------|
| `open` | Open field with scattered food clusters |
| `maze` | DFS-generated maze with food in dead ends |
| `spiral` | Concentric ring walls with gaps; food between rings |
| `field` | Open field with wandering wall segments |
| `bridge` | Vertical wall dividing the map; 2–4 bridges to cross |
| `gauntlet` | Narrow corridor connecting wide rooms |
| `pockets` | Wall grid with pocket rooms |
| `fortress` | Concentric rectangular walls |
| `islands` | Scattered wall clusters creating island regions |
| `chambers` | Connected rectangular chambers |
| `prairie` | Mostly open with sparse obstacles |
| `brush` | Dense short wall fragments |

The nest position, food placement, and wall layout are randomized per seed.
Programs must be robust across all map types — an approach that works on `open`
may fail completely on `maze` or `bridge`.

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

argc test program.alisp                           # run simulation (DEBUG=1, aborts allowed)
argc test program.alisp --no-debug                # production mode (DEBUG=0, strips ABORTs from output)
argc test program.alisp -m maze -s 100            # specific map type and seed
argc test program.alisp -o 128                    # override max ops per tick

argc debug program.alisp                          # launch interactive debugger
argc debug program.alisp -m open -s 42            # debugger with specific map

argc unit program.unit.alisp                      # run unit tests
argc unit program.unit.alisp -v                   # verbose output

argc selftest                                     # run all compiler tests
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

---

## Language Reference

### Top-Level Forms

```lisp
(const name value)              ; inline constant (no register)
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

**Direction values**: `N=1 E=2 S=3 W=4 HERE=5`. Sensing returns 0 if
nothing is found. When multiple neighbors match, one is chosen randomly.

**`sense`** scans all 4 cardinal neighbors for the given target and returns
a matching direction (random tiebreak). Returns 0 if none match.

**`smell`** finds the cardinal direction with the strongest pheromone on the
given channel. Ties broken randomly. Returns 0 if no pheromone present.

**`sniff`** reads the raw pheromone intensity (0–255) at a specific direction
and channel. Use `HERE` for the ant's own cell.

**`probe`** returns the cell type at a direction: `EMPTY=0 WALL=1 FOOD=2 NEST=3`.
Out-of-bounds or off-map cells return `WALL`.

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

**`mark`** does NOT end the tick. It adds pheromone intensity (clamped to
255) on the ant's current cell. Pheromones decay by 1 per tick globally.

**`move`** to a wall or out-of-bounds silently fails (the ant doesn't move,
but the tick still ends).

**`pickup`** on an empty cell does nothing (tick still ends). Only picks up
1 unit of food. Only works if not already carrying.

**`drop`** when carrying scores a point if the ant is on a nest cell. If
not on a nest cell, food is placed back on the ground. Does nothing if
not carrying.

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
- **Parameters**: Evaluated at the call site, then bound by name inside the macro. Variable args are passed by reference to the caller's register (allowing `set!`); literal/constant args are inlined.
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
and `include`. Any code form (e.g. `move`, `if`, `let`) in an
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

### Debug Infrastructure

AntLisp has built-in support for assertions and debugging that compiles away in production builds.

#### The `DEBUG` constant

Programs declare a `DEBUG` constant, which is `0` by default and can be overridden to `1` at the command line:

```lisp
(const DEBUG 0)

(loop
  (when DEBUG
    (abort! 42))   ; fires only when DEBUG=1
  (move random))
```

Because the compiler folds constants and eliminates dead branches, `(when DEBUG ...)` with `DEBUG=0` compiles to nothing — zero overhead in production.

#### `abort!`

```lisp
(abort! code)    ; halt this ant permanently with a numeric code
```

Permanently halts the ant. The ant stops executing for the rest of the simulation. `code` is any integer and appears in the simulator's abort report.

`abort!` is always available to the compiler. Whether it is accepted at runtime is controlled by the simulator — see [`argc test`](#running-with-argc-test) below.

#### Magic registers

Five read-only registers expose VM state at the start of each tick:

```lisp
(reg rD_FD)   ; food collected so far (at tick start)
(reg rD_CL)   ; current tick number (0-indexed)
(reg rD_PX)   ; ant's X position
(reg rD_PY)   ; ant's Y position
(reg rD_PC)   ; ant's program counter (at tick start)
```

#### Assertion pattern

The recommended pattern for in-program assertions uses `(when DEBUG ...)` to guard an `abort!`:

```lisp
(const DEBUG 0)

(defmacro check (expr expected code)
  (when DEBUG
    (when (!= expr expected) (abort! code))))

(loop
  (let ((dir (sense food)))
    (check (>= dir 0) 1 10)   ; fires with code 10 if dir is negative
    (move dir)))
```

With `DEBUG=0` (the default), the `check` macro expands to nothing. With `DEBUG=1`, it emits a conditional `ABORT`.

#### Running with `argc test`

```bash
argc test program.alisp              # default: DEBUG=1 implied, aborts allowed
argc test program.alisp --no-debug   # DEBUG=0 implied, ABORT opcode rejected by assembler
```

- **Default**: compiles with `DEBUG=1` as an implied default (overridden by any `(const DEBUG ...)` in the source), and passes `--allow-abort` to the simulator.
- **`--no-debug`**: compiles with `DEBUG=0` (overriding the source's `(const DEBUG ...)`), which strips `(when DEBUG ...)` branches from the generated assembly. The assembler also **rejects any remaining `ABORT` opcode** as a safety net — if a debug guard was accidentally omitted, the build fails with a clear error rather than silently scoring zero.

```bash
# Forgot the DEBUG guard — caught by --no-debug
$ argc test my_program.alisp --no-debug
Assembly error: Line 5: ABORT opcode is not allowed (run with --allow-abort for debug builds)
```

### Low-Level Control Flow

```lisp
(tagbody                        ; scoped label block
  tag-name                      ;   bare symbol = label
  (expr ...)                    ;   interleaved code
  (go tag-name))                ;   jump to tag (validated at compile time)
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

## Register Allocation

- **Bindings** (`let`/`let*`): allocated on entry, freed on scope exit; a `let` wrapping the main loop is effectively permanent for the program's lifetime
- **Temps**: allocated by `resolveArg` for compound sub-expressions, freed immediately

With 8 GP registers (r0-r7), a typical program uses 3–5 for long-lived state and leaves the rest for temporaries. Indices 8–12 are reserved for magic registers (`rD_FD`–`rD_PC`) and are never allocated to program variables.

The compiler performs liveness analysis, so a `let` binding does not
necessarily consume a register for its entire scope. Once a variable is
no longer referenced, its register becomes available for reuse — even
within the same `let` block. This means the practical register cost is
driven by how many variables are *simultaneously live*, not by how many
are declared.

### Avoiding register exhaustion

Register exhaustion is the most common compilation failure. Tips:

- **Count simultaneously live variables at the deepest nesting point.** Nested
  `let` blocks stack; sequential ones reuse registers. Prefer sequential when
  variables don't overlap.
- **Macros expand inline.** A macro with its own `let` bindings adds to the
  caller's register pressure at the call site.
- **Keep outer `let` bindings minimal.** Only bind what truly needs to persist
  across the entire main loop.

```lisp
; BAD — 2 registers live simultaneously
(let ((a (sense food))
      (b (smell ch_red)))
  (if (!= a 0) (move a) (if (!= b 0) (move b) (move random))))

; BETTER — 1 register at a time (sequential)
(let ((dir (sense food)))
  (when (!= dir 0) (move dir))    ; dir freed after this
  (set! dir (smell ch_red))
  (when (!= dir 0) (move dir)))   ; reuses same register
```

---

## Interactive Debugger

The debugger provides full control over simulation execution with breakpoints,
watchpoints, time travel, and detailed ant inspection.

```bash
argc debug program.alisp                  # launch debugger
argc debug program.alisp -m open -s 42    # specific map and seed
argc debug program.alisp -D FOO=100       # with const overrides
```

### Commands

**Simulation control:**

| Command | Description |
|---------|-------------|
| `continue` / `c` | Run until breakpoint/watchpoint or simulation end |
| `forward N` | Run N ticks forward (breakpoints/watchpoints apply) |
| `rewind N` | Rewind N ticks (restores from auto-snapshot) |
| `world` | Print tick, food collected, map info |
| `quit` / `q` | Exit |

**Breakpoints** — pause before a specific ant steps (all conditions AND):

```
break --id 5 --tick 100 --pc 12 --r0=3
break list
break del 1
```

**Watchpoints** — break when any ant performs a specific action:

```
watch --action PICKUP              # break on any pickup
watch --action MOVE --pos 64,58    # break on move to specific cell
watch list
watch del 1
```

**Inspection** (when paused at a breakpoint/watchpoint):

| Command | Description |
|---------|-------------|
| `info` / `i` [ID] | Full ant state: registers, position, all sensor results |
| `list` / `l` [ADDR] | Disassembly ±10 instructions around PC or ADDR |
| `step` / `s` | Execute one instruction for the current ant |
| `map` [ID] [space\|ants\|ph\|all] | 5×5 views around ant |

The debugger automatically snapshots every tick (up to 2000) so `rewind`
is always available.
