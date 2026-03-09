# Map Generation Guide

A comprehensive technical reference for all map types in the SWARM challenge. Each map has a distinct layout, food distribution, and navigation patterns designed to test different aspects of ant pathfinding and foraging behavior.

---

## Open Map

**Map Name:** `open-<seed>`

### Nest Placement
The nest is placed at a **randomized location with a 15% margin** from the map edges. The exact position is determined by the RNG and varies across seeds. The nest itself is a **3×3 square** centered at the chosen coordinates. The randomized placement ensures the nest can appear anywhere in the central 70% of the map area.

### Food Placement
Food is distributed as **5-8 circular clusters** scattered across the map. Each cluster:
- **Radius:** 3-5 cells (circular area, excluding corners)
- **Amount per cell:** 2-4 food units
- **Placement constraint:** At least `15 × scale` cells away from the nest (where scale = width / 128, roughly 15-20 cells on standard 128×128 maps)

The clusters are placed completely randomly across empty space, with no imposed structure. Food is seeded in EMPTY cells only, never overwriting walls.

### Wall Structure
Open maps have **minimal walls**—only the **mandatory border walls** on all four edges. There is no interior wall structure. The entire interior is navigable except for the border, making this the simplest pathfinding challenge.

---

## Maze Map

**Map Name:** `maze-<seed>`

### Nest Placement
The nest is placed at a **randomized empty cell** found via random search (up to 100 attempts). It appears anywhere in the central area, with no particular bias toward center or edges.

### Food Placement
Food appears as **16-22 circular clusters** scattered throughout the maze. Each cluster:
- **Radius:** 1-3 cells
- **Amount per cell:** 3-6 food units
- **Placement constraint:** Must be at least `12 × scale` cells away from the nest

Clusters are placed only in EMPTY cells with sufficient distance from the nest. This ensures food is distributed throughout the entire maze rather than clustered near the start.

### Wall Structure
Walls are generated using **Depth-First Search (DFS) maze generation**:

1. **Grid division:** The interior (excluding borders) is divided into a grid of cells, where each cell is 4×4 units
2. **DFS carving:** Starting from the center cell, a DFS algorithm randomly carves passages between adjacent grid cells. Each grid cell becomes 2×2 empty space in the actual map.
3. **Passage widths:** Corridors are typically 1-2 cells wide
4. **Gap creation:** After DFS completes, there's a 25% chance additional passages are carved between any two adjacent completed cells, creating loops and shortcuts
5. **Boundary:** All four edges are bordered with walls

The result is a classic maze with winding corridors, dead ends, and occasional alternate routes. No wide open spaces; every empty cell is part of the maze.

---

## Spiral Map

**Map Name:** `spiral-<seed>`

### Nest Placement
The nest is placed at the **center of the map** (width/2, height/2). It remains at the exact center across all seeds.

### Food Placement
Food appears in rings between the concentric wall rings:

- **Number of rings:** Creates food pockets between each wall ring
- **Placement:** 3-5 food clusters per ring gap
- **Distribution:** Clusters placed at random angles around each ring, with slight radial perturbation
- **Amount per cell:** 3-5 food units per cluster cell
- **Cluster radius:** 1-2 cells

Food is always placed in the empty regions between the walls, never on the walls themselves.

### Wall Structure
Walls form **concentric rings** radiating from the center:

1. **Ring spacing:** `max(5, 0.06 × width)` cells apart (roughly 7-8 cells on a standard 128×128 map)
2. **Ring radius:** Rings grow from innermost to near-boundary, with multiple rings (typically 2-3)
3. **Smooth curves:** Each ring is drawn with `a += 0.02` angle increments for smooth circular edges
4. **Gap in each ring:** Each ring has exactly one gap (opening), placed at a random angle
5. **Gap width:** Approximately 0.6-1.0 radians wide (roughly 1/6 to 1/3 of the circle)
6. **Wobble effect:** 
   - Amplitude: 1-2.5 cells of radial wobble
   - Frequency: 2-4 oscillations per full rotation
   - Effect increases away from the gap for smoother ring appearance

The result is a series of concentric rings with one opening per ring, forcing ants to spiral outward (or inward) through each opening to reach food in successive rings.

---

## Field Map

**Map Name:** `field-<seed>`

### Nest Placement
The nest is placed at a **randomized location with a 15% margin** from the edges, similar to the Open map. Position varies per seed.

### Food Placement
Food appears as **6-8 circular clusters**:
- **Radius:** 2-4 cells
- **Amount per cell:** 2-4 food units
- **Placement constraint:** At least `12 × scale` cells away from the nest

Clusters are placed randomly, avoiding walls and the nest area.

### Wall Structure
Field maps feature **3-5 irregular, meandering walls** drawn as random walks:

1. **Wall generation:** Each wall is a random walk starting from a random position
   - **Length:** 70-130 steps
   - **Angle changes:**±0.5 radians per step for organic curves
   - **Gaps in walls:** As the wall is drawn, segments alternate between solid wall and gap:
     - Solid segment: 8-19 cells long
     - Gap segment: 2-5 cells long (ants can pass through)
   - **Avoidance:** Walls don't generate near the nest (within 5 cells)

2. **Multiple walls:** 3-5 independent walls are generated with random start positions and directions
3. **Boundary:** Standard border walls on all edges

The result is a landscape with irregular, broken walls creating a natural-looking terrain with corridors and openings ants must navigate.

---

## Bridge Map

**Map Name:** `bridge-<seed>`

### Nest Placement
The nest is placed on the **left side** at coordinates `(width/4, height/2)`, roughly 1/4 of the way across and vertically centered. This is fixed (not randomized).

### Food Placement
Food clusters appear on the **right side of the map**, beyond the central wall:
- **Number of clusters:** 6-9
- **Location:** X-coordinate ranges from `width/2 + 4` to `width/4` from the right edge
- **Radius:** 2-4 cells per cluster
- **Amount per cell:** 3-6 food units

All clusters are on empty ground (never on walls).

### Wall Structure
A **vertical dividing wall** runs roughly down the middle with strategic bridges:

1. **Main wall structure:**
   - **Position:** Centered at approximately `width/2`, with random drift ±10% of width
   - **Thickness:** 3 cells wide (center cell ± 1)
   - **Wandering:** The wall X-position wanders slightly as it ascends (±1 cell per row with 30% probability)
   - **Extent:** Runs the full height from top to bottom border

2. **Bridges:** 2-4 openings in the wall at evenly spaced intervals
   - **Spacing:** `height / (numBridges + 1)` apart vertically
   - **Width:** 2-4 cells tall (radius ±1 to ±2)
   - **Extent:** 3 cells wide (clearing the wall thickness)

3. **Symmetry:** The entire map may be randomly flipped horizontally or vertically for variety

The result is a clear left-to-right traversal challenge: ants must find and use bridges to cross from nest to distant food.

---

## Gauntlet Map

**Map Name:** `gauntlet-${seed}`

### Nest Placement
The nest is placed at the **far left edge** at coordinates `(5, height/2)`, making it the starting point for a left-to-right challenge.

### Food Placement
Food appears in **chambers between the walls**, with **increasing density** as you progress right:

1. **Organization:** Food is placed in sections (chambers) between consecutive walls
2. **Progression:** Later chambers (further from nest) have more food:
   - Cluster count increases from 2-3 in early chambers to 4-5 in later ones
   - Cluster radius grows from 1 cell to 3+ cells
   - Amount per cell grows from 2-3 to 5+ units
3. **Placement:** Food is scattered randomly within each chamber's boundaries

This creates a **difficulty ramp**: early chambers are easy but sparse, later chambers are rich but deeper in the gauntlet.

### Wall Structure
A series of **vertical barrier walls** placed at regular intervals create chambers:

1. **Wall count:** 3-4 walls
2. **Spacing:** Evenly distributed: `(width - 20) / (numWalls + 1)` apart
3. **Position:** Wall X-coordinates are `12 + wallSpacing × (w + 1)`
4. **Extent:** Walls run nearly the full height (y = 1 to height-2)

5. **Gaps in walls:**
   - **Size:** 4-7 cells tall
   - **Alternating positions:** Odd-numbered walls have gaps in the bottom 1/3, even-numbered walls in the top 1/3
   - **Random offset:** Within the designated third, gaps are randomly placed
   - Effect: Forces zigzag navigation pattern

6. **Symmetry:** Map may be randomly flipped

The result is a linear left-to-right challenge with alternating high/low passages forcing ants to weave through the gauntlet.

---

## Pockets Map

**Map Name:** `pockets-${seed}`

### Nest Placement
The nest is placed at a **randomized location with a 15% margin** from edges, similar to Open and Field maps.

### Food Placement
Food appears **inside isolated circular pockets**:

1. **Pocket count:** 7-10 pockets scattered across the map
2. **Food location:** Food is placed only within the interior of each pocket
3. **Placement:** Food clusters fill the inner 3-4 cell radius
4. **Amount:** 2-4 food units per cell
5. **Restriction:** Food is only placed in EMPTY cells (never on pocket walls)

Pockets are randomly sized, making some easier to enter and exit than others.

### Wall Structure
Walls form **isolated circular rings** (pockets):

1. **Pocket count:** 7-10 pockets, each independently generated
2. **Sizing:** Radius 7-12 cells per pocket
3. **Spacing:** Pockets are kept at least `r + p.r + 5` cells apart to avoid overlap
4. **Nest exclusion:** Pockets don't spawn within `r + 8` cells of the nest

5. **Ring construction:**
   - Drawn as a **circular wall** around each pocket center
   - **Gap in each ring:** Exactly one opening per pocket
   - **Gap width:** 0.2-0.3 radians (roughly 1/10 to 1/6 of the circle)
   - **Gap angle:** Random per pocket
   - **Resolution:** Ring is drawn with `a += 0.025` angle increments for smooth curves

6. **Border walls:** Standard map boundaries

The result is a collection of isolated circular chambers. Ants must navigate the open space to find each pocket, enter through the gap, collect the food inside, and exit.

---

## Fortress Map

**Map Name:** `fortress-${seed}`

### Nest Placement
The nest is placed at the **top-left corner** at coordinates `(4, 4)`. This is a fixed position.

### Food Placement
Food is distributed in **two regions**:

1. **Center region:** A circular cluster in the very center
   - **Radius:** `ringSpacing - 2` cells
   - **Amount:** 3-5 food units per cell
   
2. **Between rings:** Clusters placed in the gaps between concentric fortress walls
   - **Number of rings:** 3-4 fortress rings
   - **Number of clusters:** 4-7 clusters per ring gap
   - **Placement:** Clusters are positioned at random angles around each ring, in the middle radius band
   - **Amount:** 2-5 food units per cell
   - **Size:** Single-cell placements (1 cell radius)

The nested structure forces ants to penetrate deeper rings to access more food.

### Wall Structure
Walls form **concentric rings centered at the map midpoint**, similar to Spiral but centered differently:

1. **Ring count:** 3-4 rings total
2. **Ring spacing:** `max(4, floor(min(width, height) / (2 × numRings + 4)))` cells apart (roughly 12-20 cells on standard maps)
3. **Center to nest:** The rings are centered at the map midpoint, **not at the nest** location (nest is at corner)
4. **Ring extent:** Each ring is drawn starting from radius 1 onwards

5. **Smooth curves with wobble:**
   - **Angle step:** `a += 0.015` for finer ring resolution
   - **Wobble amplitude:** 1.5-3.5 cells of radial variation
   - **Wobble frequency:** 3-5 oscillations per full circle
   - **Effect:** Creates organic, bumpy rings rather than perfect circles

6. **Gap in each ring:**
   - **Width:** 0.35-0.55 radians (roughly 1/6 to 1/4 of circle)
   - **Angle:** Random per ring
   - **Effect:** Single opening per ring that ants must find

The result is nested fortress-like rings centered at the map center, with the nest starting in the corner. Ants must spiral inward toward the center and through concentric defenses to reach the richest food.

---

## Islands Map

**Map Name:** `islands-${seed}`

### Nest Placement
The nest is placed at the **center of a randomly chosen island** from the 4×4 grid of islands. The exact island (and thus nest location) varies per seed.

### Food Placement
Food appears on the **other 15 islands** (all islands except the nest island) with **varied food patterns** per island:

1. **Pattern diversity:** Each island gets one of 5 food patterns, shuffled for variety
   - **Blob:** A 2-3 cell radius circular cluster in the island center, 1-2 food units per cell
   - **Walls:** Food scattered along the island perimeter edges only (50% chance per perimeter cell), 1 food unit each
   - **Diffuse:** Randomly scattered throughout the island interior with 12% probability per cell, 1 food per cell
   - **Corners:** 4 corner clusters (one per corner), each with 1-3 radius and 1-3 food units per cell
   - **Empty:** No food on this island (contrast to neighbors)

2. **Bridge clearance:** Food near bridges is avoided (within 5+bridgeWidth cells of any bridge connection point)
3. **Placement:** Food never overlaps with walls or other food

### Wall Structure
A **4×4 grid of island-separated regions** with connecting bridges:

1. **Island grid:** The map is divided into 4×4 sections:
   - **Island width:** `(width - 2) / 4` cells per island
   - **Island height:** `(height - 2) / 4` cells per island
   - **Interior per island:** Each island's interior is ~2 cells inset from edges (leaving wall borders)

2. **Islands are open:** The interior of each island is completely EMPTY and navigable

3. **Surrounding walls:** All space between islands is WALL

4. **Bridges between adjacent islands:**
   - **Horizontal bridges:** Connect left-right adjacent islands
     - **Count:** 1 per left-right pair
     - **Width:** 2-3 cells tall (vertical extent)
     - **Horizontal extent:** 5 cells wide (±2 from the wall boundary)
     - **Placement:** Y-position randomized within each island's height
   - **Vertical bridges:** Connect top-bottom adjacent islands
     - **Count:** 1 per top-bottom pair
     - **Width:** 2-3 cells wide (horizontal extent)
     - **Vertical extent:** 5 cells tall (±2 from the wall boundary)
     - **Placement:** X-position randomized within each island's width

5. **Bridge width type:** `2 + rng.nextInt(2)`, so 2-3 cells wide/tall

The result is a grid-based archipelago: ants start on one island and must cross bridges to other islands to gather diverse food types. Navigation is constrained to a fixed grid with limited crossing points.

---

## Chambers Map

**Map Name:** `chambers-${seed}`

### Nest Placement
The nest is placed in the **most central chamber** — the chamber whose center is closest to the map's geometric center (width/2, height/2).

### Food Placement
Food appears in **all chambers except the nest chamber**:

1. **Per-chamber food:**
   - **Cluster size:** Circular clusters with radius = min(chamber_halfsize - 1, 3)
   - **Amount:** 3-5 food units per cell
   - **Placement:** Centered within each non-nest chamber

2. **Distribution:** Each chamber gets exactly one central food cluster

### Wall Structure
A series of **randomly sized rectangular chambers** connected in a **sequential loop**:

1. **Chamber generation:**
   - **Count:** 11-13 chambers total
   - **Size range:** Each chamber is roughly 8-16 cells wide and tall (±4 from a 8-cell base)
   - **Placement:** Centers are randomly positioned with no overlap
   - **Interior:** Each chamber is a rectangular EMPTY space

2. **Corridor connections:**
   - **Path type:** Chambers are connected sequentially: 0→1→2→...→n→0 (forms a loop)
   - **Corridor width:** 3 cells wide (±1 from center line)
   - **Path algorithm:** Each corridor connects two chamber centers using right-angle paths:
     - First horizontal segment (X-alignment)
     - Then vertical segment (Y-alignment)
   - **Corners:** Natural right angles where segments meet; no curves
   
3. **Wall fill:** All space except chambers and corridors is WALL

4. **Boundary:** Standard border walls on edges

The result is a circuit of chambers connected by narrow corridors. Ants must follow the chamber network, possibly making multiple loops through all chambers to exhaustively collect food.

---

## Prairie Map

**Map Name:** `prairie-${seed}`

### Nest Placement
The nest is placed at a **randomized location with a 15% margin** from edges.

### Food Placement
Food is distributed via **density-based random generation** influenced by **hotspots**:

1. **Hotspots:** 6-9 intensity hotspots scattered across the map
   - **Radius:** 6-15 cells per hotspot
   - **Strength:** 0.25-0.55 (controls maximum density contribution)
   - **Effect:** Creates local density peaks

2. **Density calculation:** For each cell (x, y):
   - **Base density:** 0.016 (baseline, ~1.6% of cells get food)
   - **Hotspot contribution:** For each hotspot, if within radius: add `strength × (1 - distance/radius)`
   - **Cap:** Density capped at 0.25 maximum
   - **Nest exclusion:** No food within 5 cells of nest

3. **Food placement:** If random < density, place food:
   - **High density (>0.12):** 1-3 food units per cell
   - **Lower density:** 1-2 food units per cell

The result is a natural-looking prairie with scattered food, denser in hotspot regions and sparser elsewhere. Food is continuous rather than clustered, resembling scattered seeds.

---

## Brush Map

**Map Name:** `brush-${seed}`

### Nest Placement
The nest is placed at a **randomized location with a 15% margin** from edges.

### Food Placement
Food appears as **10-12 circular clusters**:

1. **Cluster search:** For each cluster, the algorithm attempts up to 80 random placements
2. **Placement constraints:**
   - Must be on an EMPTY cell (not on a wall)
   - Must be at least `10 × scale` cells away from the nest
3. **Cluster size:**
   - **Radius:** 2-4 cells
   - **Amount:** 3-5 food units per cell

Food clusters are placed in clearings within the dense brush.

### Wall Structure
Walls form **dense, pervasive brush-like obstacles**:

1. **Random wall placement:** For each cell (x, y) in the interior:
   - **Probability:** 28% chance of becoming a wall
   - **Exclusion:** No walls within 5 cells of the nest
   - **Result:** Creates a dense, maze-like forest of walls

2. **Clearing around nest:** A 7×7 square around the nest is forcibly cleared
   - Any walls in `nestX ± 3, nestY ± 3` are converted to EMPTY

3. **Wall reachability:** The `ensureFoodReachable` algorithm is applied to guarantee food clusters aren't accidentally cut off by the random wall placement

The result is a dense brush landscape with scattered clearings where food appears. Navigation is challenging due to high wall density (28% of interior cells).

---

## Common Utilities and Patterns

### Nest Definition
All maps use a **3×3 nest block** centered at (nestX, nestY):
- Covers cells from (nestX-1, nestY-1) to (nestX+1, nestY+1)
- All cells in this 3×3 area are marked as NEST type
- Food can be dropped here to register as collected

### Border Walls
All maps include **1-cell-thick border walls** on all four edges:
- Top edge: y = 0
- Bottom edge: y = height - 1
- Left edge: x = 0
- Right edge: x = width - 1

### Reachability Guarantee
Many maps apply `ensureFoodReachable()`, which uses BFS to ensure all food can be reached from the nest without walls blocking access:
- BFS from nest to find reachable cells
- For unreachable food clusters, BFS back from food toward reachable set
- Carves passages by converting WALL cells to EMPTY along the path

### Distance Metric
Food placement and other constraints use **Euclidean distance** (`sqrt((x1-x2)² + (y1-y2)²)`), not Manhattan distance.

### Symmetry Randomization
Some maps apply `randomSymmetry()` to add variety:
- Randomly applies horizontal flip, vertical flip, and/or transpose
- Maps with square dimensions can be symmetrically transformed
- Adjusts nest position accordingly
- Increases seed-to-seed variety for maps that are otherwise deterministic

---

## Map Difficulty Summary

**Easiest:**
1. **Open** - Minimal walls, simple straight-line navigation
2. **Prairie** - Scattered food, no walls, continuous distribution

**Medium:**
3. **Bridge** - Clear left-to-right path with chokepoints
4. **Field** - Random walls with gaps, multiple clusters to find
5. **Spiral** - Concentric rings with single gaps, forces systematic exploration
6. **Maze** - Complex corridors, but fully connected and navigable

**Hard:**
7. **Gauntlet** - Alternating vertical passages, forced zigzag
8. **Fortress** - Concentric rings from corner, multiple penetration depth levels
9. **Pockets** - Isolated chambers, discrete collection points
10. **Chambers** - Looping chamber network, multiple required visits
11. **Islands** - Discrete regions, limited bridges, diverse food patterns
12. **Brush** - Highest wall density (28%), most fragmented spaces
