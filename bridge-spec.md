# Bridge Forager Spec

Optimized for walled maps (especially **bridge**: a wall splits the map with 2–4 narrow crossings, all food on the far side). Also a general improvement for chambers, islands, and other walled layouts.

## Pheromones

| Channel | Purpose |
|---------|---------|
| `TRAIL` (ch_red) | Breadcrumb trail. Ants mark this every step while exploring and scanning. Creates a gradient from frontier back toward the nest so ants can retrace their path through narrow crossings. |
| `DELIVERING` (ch_blue) | Marked by returning ants carrying food. Explorers use this to head toward known food sources. |

## Registers

- `dx`, `dy` — displacement from nest (dead reckoning)
- `dir` — current movement direction
- `state` — current state (also doubles as blocked-direction storage in SCANNING)
- `steps` — steps remaining on current heading
- `ticks` — explore timer; reused as blocked-dir in SCANNING state
- `scratch` — temporary register for sensing results

## States

### EXPLORING (start state)

Goal: fan out from the nest, find food (and on bridge maps, find wall crossings).

**Every step:** mark `TRAIL 100`.

**Choosing a heading** (when `steps` runs out):

1. **DELIVERING scent here** → head opposite `SMELL DELIVERING` (away from nest, toward food sources), 1–4 ticks.
2. **No pheromone** → random non-wall direction, 1–4 ticks.

**Wall handling:** if the chosen direction is blocked by a wall, transition to **SCANNING** state. Save the blocked direction, pick a perpendicular direction, and begin probing for a gap.

**Food found:** move toward food, pickup, switch to RETURNING.

**Timeout:** after 600 ticks without food, switch to LOST.

### SCANNING

Goal: walk along a wall looking for a gap to pass through.

**Entry:** triggered when an explorer hits a wall. The blocked direction (the direction the ant wanted to go) is saved. The ant picks a random perpendicular direction to walk along the wall.

**Every step:**
1. Mark `TRAIL 100`.
2. Check if the blocked direction is now open (probe). If yes → gap found! Move through, switch back to EXPLORING.
3. If scan steps exhausted (40 steps), give up and switch back to EXPLORING.
4. If the walking direction is blocked (corner/end of wall), reverse direction.

**Food found:** grab it and switch to RETURNING (even while scanning).

This is the key mechanic for bridge maps: instead of bouncing randomly off walls, ants systematically walk along them and probe for openings. A 40-step scan covers enough of a typical bridge wall to find at least one crossing.

### RETURNING

Goal: carry food home, leaving a delivering trail.

**Every step:** mark `DELIVERING 100`.

**Navigation** (priority order):

1. **Nest adjacent** → move to nest, drop, reset dx/dy, switch to EXPLORING.
2. **Dead reckon** toward nest using dx/dy displacement.
3. **If blocked** → follow `SMELL TRAIL` (the breadcrumb gradient points back toward the nest through whatever path the ant came from, including narrow crossings).
4. **If trail also blocked** → random non-wall direction.

### LOST

Goal: get home after exploring too long without finding food.

**Navigation** (priority order):

1. **Nest adjacent** → switch to EXPLORING.
2. **DELIVERING trail found** → switch to EXPLORING (someone found food nearby).
3. **Dead reckon + trail fallback** (same as RETURNING navigation).

## Key Design Rationale

### Trail pheromone for wall navigation

Dead reckoning fails at walls — dx/dy says "go north" but a wall is in the way. The TRAIL pheromone captures actual walked paths. `SMELL TRAIL` on the food side of a bridge wall points toward the gap the ant came through, because that's where the pheromone concentration is highest (many ants walked through there).

### Wall-scanning for gap discovery

Random walks are inefficient at finding narrow gaps in long walls. The SCANNING state makes this systematic: when an ant hits a wall, it commits to walking along it while probing the blocked direction. This converts a probabilistic search into a linear scan, dramatically increasing the chance of finding crossings.

### General improvement

These mechanics help all walled maps, not just bridge. Chambers (+10%), islands (+15%), and fortress (+0.6%) all benefit from trail-guided return navigation and systematic wall scanning. Open maps are unaffected since ants rarely hit walls.

## Benchmark

Overall: **208/1000** (vs 184 for open forager, +13%)

Bridge specifically: **3.3%** (vs 0.1% for open forager)
