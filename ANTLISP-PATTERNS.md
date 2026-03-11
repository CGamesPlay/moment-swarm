# AntLisp Patterns & Pitfalls

Practical notes on writing AntLisp programs, learned from building and
refactoring real forager brains. See ANTLISP.md for the language reference.

---

## Program Structure

Every ant program follows this general shape:

```lisp
; 1. Constants and includes
(const TRAIL ch_red)
(const TIMEOUT 600)
(include "helpers.inc.alisp")

; 2. Macros
(defmacro wander () (move (+ (random 4) 1)))

; 3. Persistent state wrapping the main loop
(let ((dx 0) (dy 0) (state 0))
  ; 4. Main loop
  (loop
    ...))
```

---

## Register Budget

You have 8 registers. Every `let` binding costs one for the duration of
its scope. Compound sub-expressions allocate temp registers too. Plan
your budget before writing code:

```
; Typical budget for a forager:
;   dir, homepos = 2 persistent (all states)
;   per-state    = 2 scratch
;   ── 4 remaining for temps ──
```

**Count registers at your deepest nesting point.** The bottleneck isn't
average usage — it's the single worst-case site. Nested `let` blocks
stack: if you have 4 bindings in scope and enter a `let` with 2 more,
that's 6, leaving only 2 for temps from sub-expressions.

Use `argc compile --dump-ssa` to see what the compiler actually
allocated if you're hitting register exhaustion.

---

## Sequential vs Nested `let`

Sequential `let` blocks reuse registers; nested ones stack:

```lisp
; OK — sequential, peak = 1 extra register
(let ((a (sense food))) ...)
(let ((b (smell ch_red))) ...)

; Expensive — nested, peak = 2 extra registers
(let ((a (sense food)))
  (let ((b (smell ch_red)))
    ...))                     ; a AND b alive simultaneously
```

This matters everywhere — in top-level code, inside macros, and
especially when calling deeply nested macro chains where each layer
may open its own `let`.

---

## Scoping Variables to States

When a program has multiple states (exploring, returning, etc.) connected
by `tagbody`/`go`, resist the temptation to put all variables in one
outer `let`. Variables that are only meaningful within one state can be
scoped to that state:

```lisp
(let ((dir 0) (homepos 0))   ; truly persistent across all states
  (tagbody
    exploring
    (let ((steps 0) (age 0))  ; only meaningful during exploring
      (loop
        ...
        (go returning)))      ; go exits the let — steps/age freed

    returning
    ...
    (go exploring)))          ; re-enters the let — steps/age reinitialized
```

**Key insight:** `(go label)` that jumps *into* a `let` block re-executes
the initializers. `(go label)` that jumps to a label *inside* a `let`
does not — the bindings keep their current values. Use this deliberately:

- Jump to a label **before** the `let` to reinitialize scratch variables.
- Use `(continue)` or `(go)` to a label **inside** a `loop`/`let` to
  preserve state between iterations.

This also helps the register allocator — variables with non-overlapping
lifetimes can share the same physical register.

---

## Don't Manually Borrow Registers

It's tempting to repurpose a variable for a different meaning in another
state — e.g. using `steps` to hold a wall direction during scanning.
**Avoid this.** The compiler has liveness analysis and will recycle
registers automatically when a `let` binding is no longer referenced.
If you scope your variables properly (see above), the compiler sees
that `steps` is dead when you enter scanning and can reuse its register
for new `let` bindings.

Manual borrowing makes code harder to read, introduces coupling between
unrelated states, and fights the compiler instead of helping it.

---

## Callback-Style Macros

Macros are expressions — their last form's value is the value of the
call, just like `let` or `begin`. Simple macros can just return a value.
But when a macro needs to trigger a *control flow change* in the caller
(like transitioning to another state), it can take action parameters —
code fragments passed in and invoked at the right moment:

```lisp
(defmacro grab-food-if-adjacent (dir homepos on-success)
  (let ((food-dir (sense food)))
    (when (!= food-dir 0)
      (move dir)
      (pickup)
      (on-success))))          ; caller decides what happens

; Usage — different callers, different actions:
(grab-food-if-adjacent dir homepos (go returning))
(grab-food-if-adjacent dir homepos (continue))
```

This works because macro parameters are expanded inline —
`(on-success)` becomes whatever code the caller passed. Common patterns:

- `(go label)` — transition to another state
- `(continue)` — restart the enclosing loop
- `(break)` — exit the enclosing loop

You can nest callbacks through multiple macro layers:

```lisp
(defmacro spiral-search (dir homepos ... on-abort on-done)
  ...
  (scan-wall dir homepos ... (on-abort) (on-done)))
```

Note the extra parens: `(on-abort)` *invokes* the callback parameter,
expanding whatever the caller passed.

---

## Macros with Internal Loops

Macros can contain loops, `let` bindings, and arbitrary control flow.
Since macros expand inline, a macro with a `loop` works exactly as if
you'd written that loop at the call site:

```lisp
(defmacro scan-wall (dir homepos wall-dir scan-steps on-abort on-success)
  (loop
    ...
    (when (!= (probe wall-dir) 1)
      (set! dir wall-dir)
      (on-success))           ; caller's action breaks out of the loop
    (move dir)
    ...))
```

---

## Common Strategies

**Dead-reckoning**: Track displacement from nest using `dx`/`dy`. After each
move, update the displacement. To go home, move in the direction that reduces
`|dx|` or `|dy|`. This costs 2 permanent registers.

**Pheromone trails**: `mark` a channel when finding food. Other ants `smell`
that channel to follow the trail. Pheromones decay by 1 per tick, so trails
need reinforcement. Use separate channels for different signals (food trail,
nest gradient, etc.).

**State machines**: Use a `state` variable and `cond` to switch behavior.
Common states: exploring, returning, scanning (wall-following). Tag each
state with `(set-tag name)` for visual debugging in the viewer.

**Wall following**: When `probe` shows a wall ahead, turn perpendicular and
walk along the wall, probing for gaps each tick. Budget the scan with a
counter to avoid getting stuck.

### Pheromone channel conventions

Programs typically use channels as:

| Channel | Common use |
|---------|-----------|
| `ch_red` | Nest gradient / return trail |
| `ch_green` | Food trail / delivery trail |
| `ch_blue` | Food-was-here beacon |
| `ch_yellow` | Exploration frontier / misc |

These are conventions, not requirements. Choose whatever makes sense for
your algorithm.

---

## Common Pitfalls

- **Stalling**: If your main loop has too much computation before reaching a
  `move`/`pickup`/`drop`, the ant wastes ticks. Keep the path to an action
  under 64 ops.
- **Forgetting to loop**: The program wraps at the end (PC resets to 0),
  which re-initializes `let` bindings. Always use an explicit `(loop ...)`.
- **Moving into walls**: `(move dir)` into a wall silently fails. Always
  `(probe dir)` first if you need the move to succeed, or accept that some
  moves will fail.
- **Pheromone saturation**: `mark` adds to existing value (capped at 255).
  Marking 255 every tick creates a flat field with no gradient. Use moderate
  values (50–100) or mark conditionally.
- **Register pressure in macros**: Each macro expansion adds its `let`
  bindings to the caller's live set. A deeply-nested macro call chain can
  exhaust registers even if each macro is small.

---

## Stalls vs Score

Stalls (hitting the 64-op limit without an action) waste ticks but
don't always hurt score proportionally. A program with high stalls on
open maps may still score well because food is nearby. Stalls matter
most on maps where ants need many ticks to reach distant food.

Before optimizing for stalls, test with an inflated op limit to see
the theoretical ceiling:

```bash
argc test program.alisp -o 1000    # would stalls matter if removed?
```

If the score barely changes, stalls aren't your bottleneck — the
algorithm is.

---

## Program Size vs Stalls

There is no limit on program size (instruction count), but there IS a
64-op-per-tick limit. Every `JMP` costs an op. Macros expand inline,
which increases program size but *removes* jump overhead. A macro
called from two sites generates two copies of the code — larger binary,
but each copy runs straight-line without jumping to a shared subroutine.

This is a feature: prefer macro expansion over shared code when ops
are tight. The tradeoff is that large programs take more instruction
memory but the VM doesn't penalize that.

---

## Deterministic Scoring

The simulator is fully deterministic — same program, same score every
time. This means small score differences (±5-10 points) from pure
refactoring are real behavioral changes caused by different code layout
affecting the op budget and stall patterns, not random noise. However,
they're generally within "parameter tuning noise" — the kind of variance
you'd see from changing a single constant by 1. Don't chase these
during refactoring; focus on algorithmic improvements.
