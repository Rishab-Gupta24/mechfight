# mechbot

Bot for the mechfight/1 battle royale (TypeScript, runs on Bun).

- `map.ts` builds a 1 m grid from `/arena` (walls, line of sight, A* pathing).
- `brain.ts` handles the zone, looting, target choice, gun lead, laser charging, lightning and mortar, strafing, and retreating to cover.
- `bot.ts` is the entry point. `mechfight.ts` is the kit wrapper.
