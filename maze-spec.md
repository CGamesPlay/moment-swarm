# Maze Forager Spec

Extends bridge-bt with **wall-following during RETURNING** and **anti-reversal movement**. The core insight: on maze maps, dead-reckoning almost always hits a wall, trail pheromones are unreliable (laid by outbound explorers, not pointing home), and pure random movement traps ants in corners. The fix is to give returning ants the same wall-following ability that explorers have — when blocked, walk the corridor probing for a turn toward home.

## Problem

In bridge-bt, RETURNING does:
1. Dead-reckon toward nest
2. If blocked → follow TRAIL pheromone
3. If trail absent/blocked → random non-wall direction

On maze maps this breaks down because:
- Dead-reckoning is blocked almost every step (walls everywhere)
- TRAIL pheromone is laid by outbound explorers — the gradient points *away* from nest, not toward it, so `SMELL TRAIL` often sends the ant deeper into the maze
- Random fallback causes oscillation in corridors and corners — the ant bounces back and forth without progress

## Changes from bridge-bt

### 1. RETURNING gains wall-following (RETURN-SCANNING sub-state)

When RETURNING's dead-reckoning is blocked, instead of immediately falling through to trail/random, the ant enters a wall-following mode directly within RETURNING. This reuses the SCANNING concept but oriented toward getting home:

- Compute the desired home direction from `homepos`
- If blocked, save it as the "target direction" and walk perpendicular along the wall
- Each step, probe the target direction — if it opens up, go through
- After a budget of steps, recompute the home direction (it may have changed after moving laterally) and try again

This is the key difference: **explorers scan walls to find gaps to pass through; returning ants scan walls to find corridors that lead toward the nest.**

### 2. Anti-reversal bias everywhere

When picking a random direction, the ant avoids reversing its last movement direction. This applies in two places:

- **EXPLORING heading selection**: when no DELIVERING scent is present and the ant picks a new random heading, it avoids reversing. This prevents explorers from oscillating in corridors and wasting ticks retracing ground they just covered.
- **RETURN-SCANNING fallback**: when wall-following hits a dead end and must pick a new direction, it avoids reversing.

The `pick-nonwall-no-reverse` macro tries 3 non-reverse directions in random order before falling back to reversal as a last resort (when the other 3 are all walls).

## Pheromones

Same as bridge-bt:

| Channel | Purpose |
|---------|---------|
| `TRAIL` (ch_red) | Breadcrumb trail laid during EXPLORING and SCANNING |
| `DELIVERING` (ch_blue) | Laid by returning ants (BACKTRACKING and RETURNING). Used by explorers to find food sources. |

## Registers

Same 5 persistent registers as bridge-bt:

| Register | Purpose |
|----------|---------|
| `dir` | Current movement direction |
| `homepos` | Packed dx/dy displacement from nest |
| `path` | Packed path: last 16 directions (2 bits each, LIFO) |
| `counter` | Per-state: heading steps (EXPLORING), blocked direction (SCANNING/RETURN-SCANNING), pop steps remaining (BACKTRACKING) |
| `explore-age` | Per-state: explore timer (EXPLORING), scan countdown (SCANNING/RETURN-SCANNING) |

## States

### EXPLORING (start state)

**Modified from bridge-bt.** Fan out from nest, find food, mark TRAIL.

**Choosing a heading** (when `counter` runs out):

1. **DELIVERING scent here** → head opposite `SMELL DELIVERING` (away from nest, toward food sources), 1–4 steps.
2. **No pheromone** → random non-wall direction **with anti-reversal** (avoids reversing the current `dir`), 1–4 steps.

Otherwise identical to bridge-bt:
- On wall → transition to SCANNING
- On food → pickup, transition to BACKTRACKING
- Timeout → LOST

### SCANNING

Identical to bridge-bt. Walk along wall probing for gap, mark TRAIL.

- Gap found → EXPLORING
- Food found → BACKTRACKING
- Budget exhausted → EXPLORING

### BACKTRACKING

Identical to bridge-bt. Pop last 16 directions from path, reverse them.

- Nest adjacent → drop, EXPLORING
- Path exhausted → RETURNING
- Step blocked → RETURNING

### RETURNING

**Modified from bridge-bt.** Navigate home with wall-following ability.

**Every step:** mark `DELIVERING 100`.

**Navigation** (priority order):

1. **Nest adjacent** → move, drop, reset all state, switch to EXPLORING.
2. **Dead-reckon** toward nest using `homepos`.
3. **If blocked** → enter RETURN-SCANNING: save the desired home direction in `counter`, pick a perpendicular direction, set scan budget in `explore-age` (e.g., 15 steps), switch to RETURN-SCANNING.

### RETURN-SCANNING (new state)

Goal: walk along a wall in the corridor, probing for a turn toward the nest. Functionally identical to SCANNING but while carrying food and marking DELIVERING.

`counter` = the desired home direction (the direction that was blocked).
`explore-age` = steps remaining in wall-follow budget.

**Every step:**
1. Mark `DELIVERING 100`.
2. Check nest adjacency → drop, reset, EXPLORING.
3. Probe `counter` (desired direction). If open → go through, switch to RETURNING.
4. If budget exhausted → recompute home direction, switch to RETURNING (will re-enter RETURN-SCANNING if still blocked, but with an updated target direction).
5. If walking direction is blocked (corner/dead end) → reverse walking direction.
6. Move, update `homepos`.

**Key property:** the periodic budget expiry forces the ant to recompute its desired home direction. As the ant moves laterally along a wall, `homepos` changes — the nest might now be in a different direction. The budget reset ensures the ant adapts to this rather than fixating on a stale direction.

### LOST

Identical to bridge-bt, but with the same enhanced navigation:

1. Nest adjacent → EXPLORING
2. DELIVERING trail → EXPLORING  
3. Dead-reckon + wall-follow fallback

## Design Rationale

**Wall-following in RETURNING:** Maze corridors run in cardinal directions with right-angle turns. Dead-reckoning says "go north" but the corridor runs east-west. Without wall-following, the ant bounces off the north wall. With wall-following, it walks along the corridor probing north each step, and goes through when the corridor turns. The budget-limited recomputation prevents fixating on a stale direction — after moving laterally, the nest may be in a different direction.

**Anti-reversal:** A random walk that can reverse has a 25% chance of undoing its last step. Excluding the reverse direction guarantees forward progress in corridors. This helps both returning ants (the original motivation) and explorers (covers new ground faster, broad improvement across all map types).
