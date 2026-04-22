# CLAUDE.md

Browser-based multiplayer 3D arena shooter. Three.js + Socket.io, server-authoritative hit-scan, everything in a single Node deploy (the server also serves the static client).

## Commands

```bash
npm install      # once
npm start        # node server/index.js — listens on $PORT or 3000
```

Open `http://localhost:3000`. Every additional tab is another player.

Healthcheck: `GET /healthz` → `200 ok` (wired up for Railway).

## Layout

```
shooter-game-3d/
├─ package.json          # deps + start script (used by Railway)
├─ railway.json          # deploy config (start cmd + healthcheck)
├─ server/
│  └─ index.js           # Node + Socket.io + static files from ../client/
└─ client/
   ├─ index.html         # loads Three.js r128 + socket.io-client from CDN
   ├─ game.js            # ~1300 LOC — entire client engine
   └─ style.css          # HUD overlay
```

No bundler. No build step. All client libs are CDN `<script>` tags; `game.js` is a single classic script (uses globals `THREE`, `io`).

## Architecture

**Server** (`server/index.js`) is authoritative.
- Holds all player positions, HP, weapons, ammo, pickups.
- Tick rate **20 Hz** — broadcasts snapshot of world state on every tick.
- Hit detection server-side: ray vs obstacle slab-AABB + sphere tests against torso (r=0.6 at y+0.9) and head (r=0.4 at y+1.7).
- Shooting is hit-scan: client sends origin + direction, server validates and resolves.
- Serves `client/` as static assets (single-deploy, same origin).

**Client** (`client/game.js`).
- Three.js r128 scene, `requestAnimationFrame` loop (unbounded FPS).
- Over-the-shoulder TPS camera — camera sits at the right shoulder (`CFG.cameraRightOffset`), looks forward from its own position so the center-screen crosshair aligns with the shot ray.
- Pointer Lock for mouse look. WASD move, Space jump, Shift sprint, LMB shoot, E pickup.
- AABB collision with step-up. Client-side prediction; server reconciles.
- Remote players interpolated with a **100 ms** render delay (`CFG.interpDelay`) from a state buffer.
- HUD is plain DOM: crosshair (CSS `top/left: 50%`), HP bar, weapon/ammo, kill feed, Canvas-2D minimap, leaderboard.

## Socket events

Client → server: `join`, `move`, `rotate`, `shoot`, `pickup_weapon`.

Server → client: `init`, `state` (per-tick snapshot), `shot_fired`, `kill`, `player_died`, `you_respawned`, `pickup_spawned`, `pickup_removed`.

## Weapons

| Weapon  | Dmg   | Rate  | Ammo | Spread   |
|---------|-------|-------|------|----------|
| Pistol  | 25    | 2/s   | 12   | small    |
| Shotgun | 6×13  | 0.8/s | 6    | 10°      |
| Rifle   | 30    | 8/s   | 30   | small    |
| Sniper  | 95    | 0.5/s | 5    | minimal  |

Pickups rotate/bob on the map, respawn 10 s after pickup. A killed player drops their weapon at the death spot.

## Conventions

- Single-file client. Keep `game.js` organized by `// =====` section comments (Engine, Player model, Collision, Camera, Shooting, Effects, HUD, Networking).
- Config constants live in top-level `CFG` object — adjust tuning there first.
- Server is the source of truth for damage, kills, ammo, respawn. Client visuals can be permissive, but don't duplicate authority.
- Don't pin specific player bones — `buildPlayerModel` builds a humanoid from primitives and returns the group via `userData` references.

## Deploy

Railway picks up `package.json` + `railway.json`. If the repo root isn't `shooter-game-3d/`, set **Settings → Root Directory → shooter-game-3d**. `PORT` is read from `process.env.PORT`.

## Gotchas

- Pointer Lock requires a user gesture — clicking the canvas.
- When touching the camera, remember `tryShoot` in `game.js` uses `camera.getWorldPosition` / `getWorldDirection` — the shot ray is whatever the camera sees, so keep camera forward aligned with the player's intended aim.
- The client treats `y = 0` as feet. Torso mesh is at `y = 1.1`, head at `y = 1.75`. Server's hit spheres assume the same layout.
