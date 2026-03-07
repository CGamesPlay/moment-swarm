# Bridge-BT Forager Spec

Extends bridge.alisp with **packed-path backtracking**. When an ant picks up food, it retraces its last 16 steps exactly before falling back to dead-reckoning. This navigates back through corridors and around walls without relying on pheromone gradients, which are unreliable early in a run or on maps with sparse ant traffic.

## Pheromones

| Channel | Purpose |
|---------|---------|
| `TRAIL` (ch_red) | Breadcrumb trail. Marked every step during EXPLORING and SCANNING. Creates a gradient back toward the nest for fallback navigation through narrow crossings. |
| `DELIVERING` (ch_blue) | Marked by returning ants (BACKTRACKING and RETURNING). Explorers use this to head toward known food sources. |

## Registers

5 persistent registers, 3 free for macro temporaries.

| Register | Purpose |
|----------|---------|
| `dir` | Current movement direction |
| `homepos` | Packed dx/dy displacement from nest (signed 8-bit each, bits 7:0 and 15:8) |
| `path` | Packed path: last 16 directions, 2 bits each (LIFO stack, low bits = most recent) |
| `counter` | Per-state: heading steps (EXPLORING), blocked direction (SCANNING), pop steps remaining (BACKTRACKING) |
| `explore-age` | Per-state: explore timer (EXPLORING), scan countdown (SCANNING) |

## Path Encoding

A single 32-bit register stores up to 16 directions as a LIFO stack:

- Each direction encoded as 2 bits: N=0, E=1, S=2, W=3 (ISA direction − 1)
- Bits 1:0 = most recent direction, bits 31:30 = oldest (16th)
- `push-path!` shifts left 2, stores new direction in low bits
- `pop-path-dir!` extracts low 2 bits, shifts right 2, masks sign bits

Every successful move during EXPLORING and SCANNING pushes onto the path. Older directions (beyond 16) are silently discarded.

## States

### EXPLORING (start state)

Goal: fan out from the nest, find food, and discover wall crossings.

**Every step:** mark `TRAIL 100`. Record move in both `homepos` and `path`.

**Choosing a heading** (when `counter` runs out):

1. **DELIVERING scent here** → head opposite `SMELL DELIVERING` (away from nest, toward food sources), 1–4 steps.
2. **No pheromone** → random non-wall direction, 1–4 steps.

**Wall handling:** if the chosen direction is blocked, transition to **SCANNING**. Save the blocked direction in `counter`, pick a perpendicular direction, set `explore-age` to 40 (scan budget).

**Food found:** move toward food, pickup, set `counter` to 16, switch to **BACKTRACKING**.

**Timeout:** after 600 ticks without food, switch to **LOST**.

### SCANNING

Goal: walk along a wall looking for a gap to pass through.

**Entry:** triggered when an explorer hits a wall. `counter` holds the blocked direction. The ant picks a random perpendicular direction.

**Every step:**
1. Mark `TRAIL 100`. Record move in `homepos` and `path`.
2. Probe the blocked direction (`counter`). If open → gap found, move through, switch to **EXPLORING**.
3. If `explore-age` exhausted (40 steps), give up → **EXPLORING**.
4. If walking direction is blocked (corner/dead end), reverse.

**Food found:** grab it, set `counter` to 16, switch to **BACKTRACKING**.

### BACKTRACKING (new state)

Goal: retrace the last 16 steps to navigate back through corridors and around walls.

**Entry:** immediately after picking up food. `counter` = 16 (steps to pop). `path` holds the recorded directions.

**Every step:**
1. Check for nest adjacency → drop, reset all state, switch to **EXPLORING**.
2. If `counter` ≤ 0 → path exhausted, switch to **RETURNING**.
3. Mark `DELIVERING 100`.
4. Pop the most recent direction from `path`, reverse it (N↔S, E↔W).
5. If the reversed direction is clear → move, update `homepos`.
6. If blocked → path is broken (wall configuration changed, or path crossed a now-blocked area). Clear `path`, switch to **RETURNING**.

**Key property:** backtracking is exact retracing. If the ant went E, N, N, W to reach food, it pops W→E, N→S, N→S, E→W — walking the exact reverse path. This works through narrow corridors, around corners, and across bridge crossings where dead-reckoning would fail.

**Fallback:** after 16 pops (or if a step is blocked), the ant transitions to RETURNING for dead-reckoning the rest of the way home. The 16-step window covers the most recent and most complex part of the path — typically the part near the food source where walls are most likely to interfere.

### RETURNING

Goal: carry food home after backtracking is exhausted. Uses dead-reckoning with trail fallback.

**Every step:** mark `DELIVERING 100`.

**Navigation** (priority order):

1. **Nest adjacent** → move to nest, drop, reset all state (`homepos`, `path`, `counter`, `explore-age`), switch to **EXPLORING**.
2. **Dead reckon** toward nest using `homepos` dx/dy displacement.
3. **If blocked** → follow `SMELL TRAIL` (breadcrumb gradient points back through whatever path ants came from, including narrow crossings).
4. **If trail also blocked** → random non-wall direction.

### LOST

Goal: get home after exploring too long without finding food.

**Navigation** (priority order):

1. **Nest adjacent** → reset state, switch to **EXPLORING**.
2. **DELIVERING trail found** → reset state, switch to **EXPLORING** (someone found food nearby).
3. **Dead reckon + trail fallback** (same as RETURNING navigation).

## State Transitions

```
EXPLORING ──food──→ BACKTRACKING ──path done──→ RETURNING ──nest──→ EXPLORING
    │                    │                          │
    │                    └──────nest─────────────────┘
    │                    │
    │                    └──blocked──→ RETURNING
    │
    ├──wall──→ SCANNING ──gap──→ EXPLORING
    │              │
    │              └──food──→ BACKTRACKING
    │
    └──timeout──→ LOST ──nest/trail──→ EXPLORING
```

## Key Design Rationale

### Why backtracking helps

Dead-reckoning says "go north-west" but doesn't know about walls. Trail pheromones help, but they take time to build up and are unreliable for the first few ants through a new corridor. Backtracking is **immediate and exact** — the ant knows exactly how it got to the food and can reverse those steps without any external state.

This matters most on:
- **Bridge/gauntlet:** the path through a narrow crossing is recorded exactly; backtracking walks back through it without searching.
- **Chambers/pockets:** corridors with turns are retraced step-by-step.
- **Spiral:** the winding path back toward the center is captured in the last 16 moves.

### Why 16 steps

The path register is 32 bits, 2 bits per direction = 16 directions. This is a hardware constraint. 16 steps covers the critical "last mile" near the food — the part most likely to involve walls, turns, and narrow passages. The remainder of the journey home (closer to the nest, typically more open) is handled by dead-reckoning which works well in open areas.

### Why fall through to RETURNING

Backtracking only covers the last 16 steps. If the ant is farther than 16 steps from the nest (which is typical), it needs a second strategy for the rest. RETURNING provides dead-reckoning + trail following, which works well for the more open terrain closer to the nest.

### Path recording is always on

`move-with-tracking-bt` records into `path` in every state, including RETURNING and LOST. This is harmless — the path is cleared when the ant drops food and re-enters EXPLORING. Keeping a single movement macro avoids code duplication and keeps the instruction count down.

## Benchmark

Overall: **232/1000** (vs 212 for bridge.alisp, +9.4%)

| Map | bridge | bridge-bt | Δ |
|-----|--------|-----------|---|
| chambers | 60.0% | 71.1% | +11.1% |
| bridge | 3.9% | 7.6% | +3.7% |
| gauntlet | 1.9% | 3.9% | +2.0% |
| spiral | 11.4% | 18.0% | +6.6% |
| pockets | 0.0% | 4.6% | +4.6% |
| maze | 0.0% | 0.8% | +0.8% |
| brush | 5.9% | 6.8% | +0.9% |
| open | 47.1% | 41.7% | −5.4% |
| islands | 32.2% | 31.8% | −0.4% |
| prairie | 75.4% | 75.4% | — |
| field | 16.1% | 15.9% | −0.2% |
| fortress | 0.6% | 0.6% | — |

Walled maps see consistent improvement. Open maps dip slightly due to the higher instruction count (725 vs 577) — the extra path-recording logic costs cycles on maps where it isn't needed.
