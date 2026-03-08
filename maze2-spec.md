# Maze2 Forager Spec — Gradient Trail Homing

## Problem

Returning ants get stuck in wall-following loops. Wall-following is a local strategy with no memory of how the ant got there. The ant explored its way in — it should be able to follow its breadcrumbs back.

The existing TRAIL pheromone (flat value, 125 everywhere) doesn't help because natural decay makes newer marks stronger, so `SMELL TRAIL` points *away* from the nest.

## Core Idea: Nest-Seeded Gradient Propagation

Instead of marking a flat trail, ants propagate a **distance gradient** outward from the nest. Each ant reads the strongest TRAIL neighbor and marks its own cell one less. `SMELL TRAIL` then always points toward the nest.

### Marking Rule

Every tick during EXPLORING and RETURNING:

```
if SENSE NEST != 0:
    ; Adjacent to nest — seed the gradient
    deficit = MAX_TRAIL - SNIFF TRAIL HERE
    if deficit > 0: MARK TRAIL deficit
else:
    strongest = max(SNIFF TRAIL N, SNIFF TRAIL E, SNIFF TRAIL S, SNIFF TRAIL W)
    target = strongest - 1
    current = SNIFF TRAIL HERE
    deficit = target - current
    if deficit > 0: MARK TRAIL deficit
```

### Why GAP = 1 Works

The ant reads **already-decayed** neighbor values and subtracts 1. Decay doesn't erode the gradient because it's already baked into the reading:

```
Tick 0: Ant at nest. Marks 255.
Tick 1: Ant at step 1. Nest decayed to 254. Mark 254-1 = 253.
Tick 2: Ant at step 2. Step 1 decayed to 252. Mark 252-1 = 251.
```

Read all values at tick 10:
- Nest: 245 (or ~255 if refreshed by other ants)
- Step 1: 253-9 = 244
- Step 2: 251-8 = 243

Adjacent cells always differ by exactly 1. SMELL compares exact integers — a difference of 1 is decisive (ties only on exact equality). Range: **255 steps from nest**, covering the entire map.

### Multi-Ant Safety

Each ant reads the *actual current state* of the pheromone field and marks relative to it. There's no "my gradient" vs "your gradient" — there's one shared gradient field that all ants collaboratively maintain.

- A far ant reads lower neighbors, computes a lower target, and deficit-marks less (or nothing).
- A close ant reads higher neighbors, computes a higher target, and refreshes decayed cells.
- The gradient always reflects the shortest explored path to the nest.

**Multiple ants on the same cell:** All read the same `current`, compute the same deficit, and all MARK it — overshooting. This only matters near the nest (crowding). Near the nest, deficits are small (0-1) and all cells are similarly boosted, so gradient shape is preserved. Far from nest, ant density is ~0.01/cell.

## States

### EXPLORING (start state)

Fan out from nest, find food, propagate gradient trail.

**Every step:**
1. Gradient marking (see marking rule above)
2. Gradient check: if `SNIFF TRAIL HERE < GRADIENT_GO_HOME` → transition to RETURNING
3. Delivery trail crossing (from maze-spec, unchanged)
4. Heading selection: follow DELIVERING toward food, or random non-wall with anti-reversal
5. Wall → SCANNING
6. Food → pickup, transition to RETURNING
7. Move forward, increment explore-age

### SCANNING

Same as maze-spec. Walk along wall probing for gap. Also does gradient marking every step.

### RETURNING

Navigate home by following the gradient trail.

**Every step:**
1. **Nest adjacent** → move, drop, reset `homepos = 0`, reset other counters, transition to EXPLORING.
2. If carrying food: mark `DELIVERING DELIVERING_STRENGTH`. If not carrying: check if `SNIFF TRAIL HERE >= GRADIENT_NEAR_HOME` → resume EXPLORING.
3. Gradient marking (reinforce trail on the way home).
4. **Follow gradient:** `dir = SMELL TRAIL`. If `dir != 0` and not blocked → move, continue RETURNING.
5. **Fallback** (no trail or blocked): dead-reckon toward nest (home-dir from homepos). If also blocked, pick random non-wall direction, then move.

## Pheromones

| Channel | Purpose |
|---------|---------|
| `TRAIL` (ch_red) | **Gradient** field: intensity decreases with distance from nest. Maintained by all ants. |
| `DELIVERING` (ch_blue) | Laid by returning ants. Used by explorers to find food sources. |

## Constants

| Constant | Default | Notes |
|----------|---------|-------|
| `MAX_TRAIL` | 255 | Seed intensity at the nest cell. |
| `SCAN_STEPS` | 30 | Wall-follow budget in SCANNING |
| `HEADING_STEPS` | 26 | Max steps per heading |
| `DELIVERY_THRESHOLD` | 150 | Min explore-age before responding to delivery trails |
| `DELIVERING_STRENGTH` | 100 | DELIVERING mark intensity |
| `GRADIENT_GO_HOME` | 2 | Explorer turns back if gradient here < this |
| `GRADIENT_NEAR_HOME` | 32 | Returner resumes exploring once gradient >= this |

## Design Rationale

### Why neighbor-max propagation (not step counter)

A step-counter approach (`mark = 255 - N*step`) fails because:
1. Steps ≠ distance from nest (ant wanders non-linearly)
2. Marks at different times decay differently — the gradient equation depends on when you read
3. Multi-ant corruption when a far ant's step count produces a higher mark than a near ant's

Neighbor-max is purely reactive — read what's there, mark one less. Decay is already factored in. No state to maintain. Inherently multi-ant safe.

### Why returning ants also mark TRAIL

A returning ant walks back through the corridor it explored, refreshing the gradient. Without re-marking, the trail decays and may vanish before the ant reaches the nest. This also means high-traffic corridors (successful paths) are well-maintained while dead ends decay away — emergent path optimization.

### Why no BACKTRACKING, RETURN-SCANNING, or LOST states

The gradient trail replaces all of these. An ant that picked up food simply follows `SMELL TRAIL` home — no need to retrace a packed path, wall-follow, or enter a lost recovery mode. The gradient is a global signal that works everywhere the ant has explored. Dead-reckoning serves as a simple fallback for the rare case where the gradient has fully decayed.

### Opcode budget

Gradient marking: 5 SNIFFs (~2 ops each) + max comparisons (~4 ops) + deficit logic (~3 ops) ≈ 17 instructions. Rest of tick logic: ~25-30 instructions. Total ~45, within the 64-opcode limit.
