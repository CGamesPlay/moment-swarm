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

### 2. Anti-reversal bias in random fallback

When all else fails and the ant must pick a random direction, it avoids reversing its last direction. In a 2-wide corridor this guarantees forward progress instead of oscillation.

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

Identical to bridge-bt. Fan out from nest, find food, mark TRAIL.

- Pick headings influenced by DELIVERING scent (head toward food sources)
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
                            │
                            └──wall──→ (wall-follow within LOST)

RETURNING ──blocked──→ RETURN-SCANNING ──gap──→ RETURNING
                            │
                            └──budget──→ RETURNING (recompute dir)
```

## Key Design Rationale

### Why wall-following in RETURNING matters for mazes

Maze corridors run in cardinal directions with right-angle turns. Dead-reckoning says "go north" but the corridor runs east-west. Without wall-following, the ant just bounces off the north wall. With wall-following, it walks east (or west) along the corridor, probing north each step. When the corridor turns north, it goes through. This is exactly what SCANNING does for explorers — now returning ants get the same ability.

### Why budget-limited wall-following with recomputation

A fixed target direction becomes stale as the ant moves laterally. If the ant wants to go north but walks 20 steps east along a wall, the nest may now be northwest or even west. The 15-step budget forces a direction recompute, keeping the wall-following oriented toward the actual nest position rather than a stale heading.

### Why anti-reversal helps in corridors

In a 2-wide maze corridor, a random walk that can reverse has a 25% chance of going backward each step — effective speed drops to near zero. Excluding the reverse direction means the ant always makes progress along the corridor, even when it can't determine which end leads home.
