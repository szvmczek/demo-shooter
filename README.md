# Shooter 3D

Multiplayer 3D arena shooter w przeglądarce — Three.js + Socket.io. TPS, autorytatywny serwer, hit-scan, wszystko w jednym deployu (serwer Node serwuje też pliki klienta).

## Struktura

```
shooter-game-3d/
├─ package.json       # deps + start script (używane przez Railway)
├─ railway.json       # konfiguracja deployu
├─ .gitignore
├─ server/
│  └─ index.js        # Node + Socket.io + static files
└─ client/
   ├─ index.html      # ładuje Three.js + socket.io z CDN
   ├─ game.js         # silnik gry
   └─ style.css
```

## Lokalne uruchomienie

```bash
cd shooter-game-3d
npm install
npm start
```

Otwórz w przeglądarce **http://localhost:3000**. Druga karta = drugi gracz.

> Można też otworzyć `client/index.html` bezpośrednio (file://) — w takim przypadku klient domyślnie połączy się z `http://localhost:3000`.

## Deploy na Railway

### Wariant A — przez GitHub (zalecany)

1. Zainicjuj repo i wrzuć na GitHub:
   ```bash
   cd shooter-game-3d
   git init
   git add .
   git commit -m "initial"
   git branch -M main
   git remote add origin git@github.com:<user>/<repo>.git
   git push -u origin main
   ```
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → wybierz repo.
3. Railway wykryje `package.json`, zainstaluje deps i uruchomi `npm start`. Start command i healthcheck są zapisane w `railway.json`.
4. Po deployu: zakładka **Settings → Networking → Generate Domain** → masz publiczny URL.
5. Wejdź na ten URL — działa. Otwórz w drugiej karcie/urządzeniu — pełny multiplayer.

### Wariant B — przez CLI

```bash
npm i -g @railway/cli
railway login
cd shooter-game-3d
railway init
railway up
railway domain         # wygenerowanie publicznego URL
```

### Zmienne środowiskowe
Nie są wymagane. Railway automatycznie ustawia `PORT` — serwer go czyta przez `process.env.PORT`.

### Healthcheck
Endpoint `/healthz` zwraca `200 ok` — już podpięty w `railway.json`.

## Sterowanie

| Klawisz | Akcja |
|---------|-------|
| **WASD** | Ruch |
| **Mysz** | Celowanie / rotacja kamery |
| **LMB** | Strzał |
| **E** | Podnieś broń |
| **Spacja** | Skok |
| **Shift** | Sprint (1.8×) |
| **Esc** | Zwolnij kursor |

## Bronie

| Broń | Dmg | Rate | Ammo | Rozrzut |
|------|-----|------|------|---------|
| Pistol | 25 | 2/s | 12 | mały |
| Shotgun | 6×13 | 0.8/s | 6 | 10° |
| Rifle (AR) | 30 | 8/s | 30 | mały |
| Sniper | 95 | 0.5/s | 5 | minimalny |

Bronie leżą na mapie (obracają się, świecą). Po 10 s od podniesienia respawnują się. Broń zabitego gracza upada w miejscu śmierci (drop — znika po podniesieniu).

## Architektura

### Serwer (`server/index.js`)
- Node.js + Socket.io, port `process.env.PORT || 3000`
- Autorytatywny: trzyma pozycje, HP, bronie, amunicję
- Game loop **20 Hz**: broadcast snapshot stanu
- Hit detection po stronie serwera (slab AABB vs kolizje, sphere test vs tors/głowa gracza)
- Serwuje również pliki klienta z `../client/` (single-deploy)
- Eventy: `join`, `move`, `rotate`, `shoot`, `pickup_weapon`, `shot_fired`, `kill`, `player_died`, `you_respawned`, `pickup_spawned`, `pickup_removed`

### Klient (`client/game.js`)
- Three.js r128 + socket.io-client (z CDN)
- Domyślnie łączy się z tym samym origin (lub `localhost:3000` przy file://)
- Model humanoidalny z prymitywów + animacja + nametag
- Kamera TPS, Pointer Lock, grawitacja, kolizje AABB ze step-up
- Efekty: smugi, muzzle flash, iskry, recoil
- HUD: crosshair, HP, ammo, kill feed, minimapa Canvas 2D, leaderboard
- Interpolacja pozycji innych graczy (100 ms render delay)

## Troubleshooting

- **Railway build zawodzi** — sprawdź czy `package.json` i `railway.json` są w root repo (czyli w `shooter-game-3d/`). Jeśli wrzuciłeś cały folder `shooter_game/` jako repo, ustaw w Railway *Settings → Root Directory* → `shooter-game-3d`.
- **Nie łączy się na Railway** — otwórz DevTools → Console. Jeśli widzisz `Mixed content`, upewnij się że URL w polu "Server" jest na `https://`. Puste pole = auto-detect, zazwyczaj działa.
- **Pointer Lock nie działa** — kliknij w obszar gry. Wymagane jest user gesture.
