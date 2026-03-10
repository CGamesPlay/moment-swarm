Pheromones: EXPLORING, DELIVERING
Start state: exploring

# State: exploring

Choose a heading and a duration. Walk there that many ticks. If a wall is encountered, restart exploring. If food is present, grab and change to returning.

If exploring has gone on for 100 ticks, change to lost.

When choosing a heading and duration:
- if SNIFF HERE DELIVERING, pick the direction opposite SMELL DELIVERING, random 1-4 ticks
- if SENSE DELIVERING, that direction for 1 tick
- choose randomly, 1-4 ticks

# State: lost

Walk towards home. If SNIFF HERE DELIVERING, change to exploring. If nest is present, change to exploring.

# State: returning

Walk towards home. If nest is present, drop and change to exploring. Always mark DELIVERING 100.
