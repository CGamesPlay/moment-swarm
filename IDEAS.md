# tracing4 Optimization Ideas

Baseline: open2 at ~568 avg (seeds 1-10)

## Kept ✅

### Remove gradient-too-weak bailout (+114 pts)
Removed the `GRADIENT_GO_HOME` check that made ants retreat when gradient was low. Ants now explore indefinitely without turning back at the frontier. Monotonic improvement: tested via scout fraction sweep (SCOUT_FRAC=2 at 697, then full removal at 724). The gradient bailout was the single biggest thing holding the program back — ants were retreating from the frontier instead of pushing through to find food.

**Score: 610 → 724**

### Trace-home budget (+20 pts)
Added `TRACE_HOME_BUDGET=60` — ants tracing walls home bail out after 60 steps and dead-reckon instead. HP sweep showed clear signal (S/N=0.58), longer budgets better, sweet spot 50-80. Prevents ants from getting stuck tracing concentric walls indefinitely in fortress/spiral.

**Score: 724 → 745**

### Non-carrying ants skip RETURNING (neutral, kept for simplicity)
Non-carrying ants in RETURNING now immediately `(go exploring)` instead of checking `GRADIENT_NEAR_HOME`. Logically correct simplification — removed dead constant. Score neutral (~722 vs 724).

## Hyperparameter Sweep Results 📊

All sweeps run post-bailout-removal with 10 seeds.

| Parameter | Value | S/N | Range | Verdict |
|-----------|-------|-----|-------|---------|
| HEADING_STEPS | 40 | 0.27 | 730-748 | Weak trend toward longer. 60 best in sweep but −16 when applied. Keep 40. |
| WALL_LEAVE_CHANCE | 20 | 0.20 | 734-748 | Weak trend toward longer traces. 40 best in sweep but −12 when applied. Keep 20. |
| OPENING_ENTER_CHANCE | 2 | 0.14 | 736-746 | No signal. 2 confirmed optimal. |
| WRONG_WAY_CHANCE | 6 | 0.10 | 739-746 | Pure noise. 6 confirmed. |
| SPIRAL_RADIUS | 3 | 0.21 | 731-746 | 3 optimal. Larger spirals waste time. |
| TRACE_HOME_BUDGET | 60 | 0.58 | 708-746 | **Clear signal.** 60 is sweet spot. Only param with real signal. |
| DELIVERY_GO_TOWARD | 2 | 0.09 | all within 6 pts | Pure noise. 2 confirmed. |

**Key insight**: HEADING_STEPS=60 and WALL_LEAVE_CHANCE=40 both looked promising in isolation but regressed when applied (−16 and combined −12). The sweep "winners" were within noise of current values. TRACE_HOME_BUDGET is the only parameter with a statistically meaningful signal.

## Failed ❌

### Crowding pheromone on ch_yellow (−2 to −9 pts)
Added `ch_yellow` marking in tracing-out/exploring with probabilistic detach when crowding detected. Caused premature wall detaches on brush/maze where wall-tracing is productive. tracing4's gradient homing already provides natural dispersion.

### Adaptive wall-leave chance (neutral, S/N=0.09)
Replaced fixed `WALL_LEAVE_CHANCE` with formula based on gradient intensity (detach faster near nest, trace longer at frontier). HP sweep showed no signal — seed variance (~76 pts) dominates.

### Delivery trail retrace after drop (neutral, +2 pts)
After dropping food at nest, smell `DELIVERING_PH` to set outbound direction back toward food source. +74 instructions due to breaking compiler deduplication of nest-check blocks. Neutral result.

### Lower DELIVERY_GO_TOWARD threshold (neutral, S/N=0.09)
Swept DELIVERY_GO_TOWARD from 1 to 5. All values within 6 points — pure noise.

### Peek-and-return on wall openings (−36 pts)
Step into opening, check for food/delivering/pickup signals, commit if promising, step back otherwise. 983 instructions (near limit), 2-tick cost per unproductive peek paid almost every time.

### Flat wall reversal budget in tracing-out (−18 pts)
After N steps tracing without finding opening, reverse CW→CCW. Hurts on maze/brush/spiral where continuous tracing is productive — flipping mid-trace sends ant back over covered ground. Gauntlet unchanged (~17%).

### 8-way diagonal movement in EXPLORING (−33 pts)
Diagonal = 2 cardinal MOVEs per tick. Per-tick op overhead (odd/even check, probe, turn-right) adds stalls that outweigh angular diversity gain.

### WRONG_WAY_CHANCE sweep (neutral, S/N=0.10)
Swept values 2-8. Pure noise, range 739-746.

### ch_yellow anti-crowding in exploring + tracing-out (neutral, +3-5 pts)
Added crowd marking and crowd-avoidance direction bias. +29 instructions, extra sniff/smell ops increased stalls that cancelled small fortress/gauntlet gains.

### Double-mark gradient at frontier (−14 pts)
Post-move `mark-gradient-propagate` when gradient < threshold. +11 instructions, ~15 extra ops/tick at frontier causes stalls. Tiny fortress/gauntlet gain (+1-2%) doesn't compensate. Gradient propagation speed is not the bottleneck.

### HEADING_STEPS=60 applied (−16 pts)
Sweep suggested 60, but actual 10-seed test scored 729 vs 745 baseline. Sweep winner was within noise.

### WALL_LEAVE_CHANCE=40 + HEADING_STEPS=60 combined (−12 pts)
Both sweep winners applied together scored 733 vs 745 baseline. Negative interaction.

### Lighter gradient in tracing-out (+4.3 pts, 20 seeds)
Replaced `mark-gradient TRAIL_PH nest` with `mark-gradient-propagate TRAIL_PH` in tracing-out. Saves ~6 ops per tick by skipping the seed check (ants are rarely adjacent to nest/food during wall tracing). Reduces stalls by ~10K/seed. Gains on islands (+2.0%), maze (+1.5%), brush (+1.4%), pockets (+1.2%). Applied to tracing4.alisp.

**Score: 725.1 → 729.4 (seeds 1-20)**

## Failed ❌ (batch 2)

### Delivery trail re-use at nest (neutral, −1.8 pts)
After drop, smell DELIVERING_PH to seed outbound direction back toward food source. Ants already follow delivering trails during exploring within a few steps, so this adds nothing. +8 instructions.

### Wall-memory pheromone ch_yellow (neutral, −0.8 pts)
Mark ch_yellow while tracing walls; skip already-traced walls on re-encounter. Pheromone decay too fast to provide useful memory. Stalls increased from ants spending more time in exploring. +17 instructions.

### Reverse-CW on re-encounter (−14 pts)
When entering tracing-out and ch_yellow on wall-side is strong, flip CW direction to trace opposite way. Massive stall increase (345K vs 150K) — every ant's marking triggers the next ant to flip, creating ping-pong behavior.

### Gap-biased tracing / gradient through walls (neutral, −0.6 pts)
Suppress random detach when TRAIL_PH gradient on wall-side is strong (indicating important territory beyond wall). Gradient doesn't meaningfully vary along walls — it's all roughly the same distance from the seed.

### Adaptive trace commit / curvature counter (−84 pts)
Suppress random detach after N trace-out steps (commit to longer walls). Catastrophic — ants get permanently stuck on walls after 8 steps. No good way to distinguish "this is a ring I should commit to" from "this is a maze wall I should leave."

### Center-bias exploration / outward drift (−71 pts)
50% chance to bias heading away from nest. Creates ant herding (all going same direction), reduces coverage diversity. Random exploration is genuinely better for coverage.

### Brush stall reduction / skip short walls (neutral, −0.9 pts)
Skip tracing-out for single-cell wall obstacles (wall-side already clear). Too narrow — most brush walls aren't single cells, they're clusters.

### Pickup beacon in tracing-out (+4.4 pts, 20 seeds, not applied)
Check PICKUP_PH during tracing-out and spiral if detected. Gains on pockets (+3.8%) and islands (+2.6%). However, does NOT combine with lighter gradient — together they score −3.1 pts. The pickup spiral disrupts wall tracing quality in mazes. Kept as separate option.

### Pickup beacon + lighter gradient combined (−3.1 pts, 20 seeds)
Negative interaction between two individually positive changes. The lighter gradient reduces gradient quality at the frontier, making post-spiral gradient following less reliable.

### Always enter openings in tracing-out (−5.4 pts)
Changed OPENING_ENTER_CHANCE from 2 (50%) to always (100%). Ants leave walls too quickly on maps where sustained tracing is productive.

### Lower PICKUP_SIGNAL threshold (neutral, +1.0 pts)
Lowered from 10 to 3. Within noise.

## Untested 💡

### Sniff delivering from tracing-home
Ants tracing walls home could detach toward a delivery trail instead of only escaping via direction match.

### Returning ants follow delivery trail outward (cheaper attempt)
After drop, follow delivery trail without the instruction cost of the prior attempt. Possibly by restructuring code to avoid breaking compiler deduplication.

### Gauntlet/fortress targeted strategies
These maps remain at 11-17%. The bottleneck is finding gaps in walls, not gradient propagation or exploration speed. Ideas: probe-ahead from wall-trace position, use pheromone to mark "already traced this wall."

### Time-based strategy shift (requires non-debug tick register)
Use `(reg rD_CL)` to shift behavior over time: aggressive exploration early, exploitation late. Requires using a magic register that's currently classified as debug-only.
