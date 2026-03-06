SWARM — Ant Colony Optimization Challenge

  200 ants share one program on a 128x128 grid.
  Find food, bring it to the nest. Communicate
  only through pheromone trails. Score across 120
  maps. Hit play to see the default code run,
  then improve it.

─────────────────────────────────────────────

QUICK START

  SENSE FOOD r1       ; scan 4 adjacent cells for food
  MOVE r1             ; walk toward it
  PICKUP              ; grab one unit
  SENSE NEST r1       ; find the way home
  MOVE r1             ; walk toward nest
  DROP                ; deliver (scores if at nest)

─────────────────────────────────────────────

LANGUAGE

  Antssembly is like assembly. The program
  counter persists across ticks — your ant's
  "brain" is  a continuous loop, not restarted
  each tick.

  DIRECTIVES

    .alias dir r1         ; name a register
    .alias trail r2
    .const FOOD CH_RED    ; named constant
    .tag 0 forager        ; name a tag (see TAGS)
    .tag 1 scout

  .tag names double as constants, so you can
  write  TAG forager  instead of  TAG 0.

  LABELS

    search:
      SENSE FOOD dir
      JEQ dir 0 wander
      MOVE dir
      PICKUP
      JMP search
    wander:
      MOVE RANDOM

  ENTRYPOINT

    If a  main:  label exists and isn't at the
    top, a  JMP main  is auto-prepended.

  REGISTERS   r0-r7, 8 general purpose.
              Signed 32-bit integers, init to 0.
              Overflow wraps (32-bit signed).
  COMMENTS    ; everything after semicolon.

─────────────────────────────────────────────

SENSING

  All sensing ops take an optional dest register
  (defaults to r0 if omitted).

  SENSE <target> [reg]  scan 4 adjacent cells
    targets: FOOD  WALL  NEST  ANT  EMPTY
    returns direction (N=1 E=2 S=3 W=4), 0=none
    ties broken randomly

  SMELL <ch> [reg]      strongest pheromone dir
    ties broken randomly
  SNIFF <ch> <dir> [reg]  intensity 0-255
    dir: HERE N E S W RANDOM (or register)
  PROBE <dir> [reg]     cell type at direction
    returns 0=EMPTY 1=WALL 2=FOOD 3=NEST
  CARRYING [reg]        1 if holding food
  ID [reg]              ant index (0-199)

─────────────────────────────────────────────

ACTIONS — end the ant's tick

  MOVE <dir>    N/E/S/W, RANDOM, or register
  PICKUP        pick up 1 food from current cell
  DROP          drop food (scores if at nest)

  Each ant carries at most 1 food. Multiple ants
  can share a cell (no collisions). Each tick runs
  until an action or the 64-op limit. Then the next
  ant goes. After all 200 ants act, pheromones decay.

─────────────────────────────────────────────

PHEROMONES — 4 channels, intensity 0-255

  CH_RED  CH_BLUE  CH_GREEN  CH_YELLOW
  Toggle R/B/G/Y in the viewer to see them.

  MARK <ch> <amount>  add to pheromone on this cell
                      (additive, capped at 255)

  Trail pattern:
    MARK CH_RED 100     ; add to breadcrumb
    SMELL CH_RED r2     ; follow gradient
    MOVE r2

─────────────────────────────────────────────

ARITHMETIC

  SET r1 5          ADD r1 1          SUB r1 1
  MOD r1 4          MUL r1 3          DIV r1 2
  AND r1 0xFF       OR r1 1           XOR r1 r2
  LSHIFT r1 4       RSHIFT r1 4       RANDOM r1 4
  Second operand can be a register or literal.

  DIV truncates toward zero. MOD is always
  non-negative. Both are no-ops if divisor=0.
  SHR is arithmetic (sign-preserving).
  RANDOM r1 N sets r1 to a value in [0, N).

─────────────────────────────────────────────

CONTROL FLOW

  JMP <label>               unconditional
  JMP <reg>                 indirect (jump to address in reg)
  CALL <reg> <label>        save return addr in reg, jump
  JEQ <a> <b> <label>       jump if a == b
  JNE <a> <b> <label>       jump if a != b
  JGT <a> <b> <label>       jump if a > b
  JLT <a> <b> <label>       jump if a < b

  Function call pattern:
    CALL r7 my_func       ; save return addr, jump
    ; ...returns here...
    my_func:
      ; do work
      JMP r7              ; return to caller

─────────────────────────────────────────────

TAGS — role heatmaps for debugging

  TAG <value>       set ant tag 0-7 (ZERO COST)

  .tag 0 forager    name tags for viewer toggles
  .tag 1 scout      then use:  TAG forager

  Toggle tag heatmaps in the viewer to see
  where each role's ants have walked. Useful
  for visualizing role specialization:

    ID r3
    MOD r3 4
    TAG r3            ; 4 roles, 4 heatmaps

─────────────────────────────────────────────

THE GRID

  EMPTY  passable       WALL   impassable
  FOOD   1-8 units      NEST   deliver here

  Directions: N E S W (or NORTH EAST SOUTH WEST)
  RANDOM = random cardinal direction each call

─────────────────────────────────────────────

MAP TYPES — 12 procedural generators

  Your score is averaged across 120 maps drawn
  from these types, seeded deterministically.

  open      No internal walls. Random food
            clusters scattered around the nest.

  maze      Wide-corridor maze. 2-wide passages,
            2-wide walls.

  spiral    Concentric wavy ring walls with wide
            random gaps.

  field     Nearly open, a few lazy curvy walls.

  bridge    A vertical wall splits the map with
            2-4 narrow crossings. All food is
            on the far side from the nest.

  gauntlet  Nest far left, food far right.
            Staggered vertical walls with gaps.

  pockets   Circular walled cells with narrow
            entrances and food inside.

  fortress  Nest cornered behind wavy concentric
            walls with gates. Food is deep
            inside the fortress.

  islands   Rooms separated by walls with one
            doorway between adjacent rooms.

  chambers  Rooms carved in rock connected by
            narrow corridors.

  prairie   Food everywhere at varying density,
            no blobs.

  brush     Dense random wall clutter throughout.
            Food in medium clusters.

─────────────────────────────────────────────

SCORING

  Each map: food delivered / food available.
  Score = average ratio across 120 maps * 1000.
  Deterministic — same code, same score.

─────────────────────────────────────────────

TIPS

  1. Read the default code — it's a complete
     two-trail forager with comments.
  2. SENSE/SMELL return directions — pass to MOVE
  3. MARK when carrying, SMELL when searching
  4. ID + MOD for role specialization
  5. SNIFF reads exact intensity for smarter
     routing (e.g. pick strongest neighbor)
  6. .alias and .tag cost nothing — use them