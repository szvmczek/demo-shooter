// Authoritative 3D shooter server - Node.js + Socket.io
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20; // broadcasts per second
const MAP_SIZE = 200;

// ---------- Static file serving (client) ----------
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.map':  'application/json; charset=utf-8',
    '.wasm': 'application/wasm'
};

// ---------- Weapons ----------
const WEAPONS = {
    pistol:  { name: 'pistol',  damage: 25, fireRate: 2,   ammoMax: 12, spread: 2,  pellets: 1 },
    shotgun: { name: 'shotgun', damage: 13, fireRate: 0.8, ammoMax: 6,  spread: 10, pellets: 6 },
    rifle:   { name: 'rifle',   damage: 30, fireRate: 8,   ammoMax: 30, spread: 3,  pellets: 1 },
    sniper:  { name: 'sniper',  damage: 95, fireRate: 0.5, ammoMax: 5,  spread: 0.5, pellets: 1 }
};

// ---------- Spawn points ----------
// y is feet position (0 = ground). Server hit-detection offsets torso/head from here.
const SPAWN_POINTS = [
    { x:  60, y: 0, z:  60 },
    { x: -60, y: 0, z:  60 },
    { x:  60, y: 0, z: -60 },
    { x: -60, y: 0, z: -60 },
    { x:   0, y: 0, z:  80 },
    { x:   0, y: 0, z: -80 }
];

// ---------- World obstacles (AABB boxes, shared with client) ----------
// Each obstacle: { x, y, z, sx, sy, sz } - center + half-extents
const OBSTACLES = [
    // Buildings (hollow — walls placed separately)
    // Building 1 - NW
    { x: -40, y: 3, z: -40, sx: 10, sy: 3, sz: 0.5 }, // back wall
    { x: -40, y: 3, z: -30, sx: 3,  sy: 3, sz: 0.5 }, // front wall left
    { x: -35, y: 3, z: -30, sx: 2,  sy: 3, sz: 0.5 }, // front wall right (door gap between)
    { x: -50, y: 3, z: -35, sx: 0.5,sy: 3, sz: 5   }, // left wall
    { x: -30, y: 3, z: -35, sx: 0.5,sy: 3, sz: 5   }, // right wall

    // Building 2 - NE
    { x:  40, y: 3, z: -40, sx: 10, sy: 3, sz: 0.5 },
    { x:  40, y: 3, z: -30, sx: 3,  sy: 3, sz: 0.5 },
    { x:  45, y: 3, z: -30, sx: 2,  sy: 3, sz: 0.5 },
    { x:  30, y: 3, z: -35, sx: 0.5,sy: 3, sz: 5   },
    { x:  50, y: 3, z: -35, sx: 0.5,sy: 3, sz: 5   },

    // Building 3 - center
    { x:   0, y: 3, z:  10, sx: 12, sy: 3, sz: 0.5 },
    { x:  -8, y: 3, z:  22, sx: 4,  sy: 3, sz: 0.5 },
    { x:   5, y: 3, z:  22, sx: 3,  sy: 3, sz: 0.5 },
    { x: -12, y: 3, z:  16, sx: 0.5,sy: 3, sz: 6.5 },
    { x:  12, y: 3, z:  16, sx: 0.5,sy: 3, sz: 6.5 },

    // Building 4 - SW with ramp
    { x: -50, y: 3, z:  40, sx: 8,  sy: 3, sz: 0.5 },
    { x: -50, y: 3, z:  50, sx: 3,  sy: 3, sz: 0.5 },
    { x: -45, y: 3, z:  50, sx: 2,  sy: 3, sz: 0.5 },
    { x: -58, y: 3, z:  45, sx: 0.5,sy: 3, sz: 5   },
    { x: -42, y: 3, z:  45, sx: 0.5,sy: 3, sz: 5   },

    // Crates (cover)
    { x:  15, y: 1,   z:  15, sx: 1.5, sy: 1,   sz: 1.5 },
    { x:  18, y: 0.75,z:  18, sx: 1,   sy: 0.75,sz: 1   },
    { x: -15, y: 1,   z:  25, sx: 1.5, sy: 1,   sz: 1.5 },
    { x: -20, y: 1.5, z:  25, sx: 1.5, sy: 1.5, sz: 1.5 },
    { x:  25, y: 1,   z: -15, sx: 2,   sy: 1,   sz: 2   },
    { x:  30, y: 0.75,z: -20, sx: 1,   sy: 0.75,sz: 1   },
    { x: -25, y: 1,   z: -15, sx: 1.5, sy: 1,   sz: 1.5 },
    { x: -30, y: 1.5, z: -20, sx: 2,   sy: 1.5, sz: 2   },
    { x:   5, y: 1,   z:  45, sx: 1.5, sy: 1,   sz: 1.5 },
    { x:  10, y: 0.75,z:  50, sx: 1,   sy: 0.75,sz: 1   },
    { x:  55, y: 1,   z:   5, sx: 1.5, sy: 1,   sz: 1.5 },
    { x:  60, y: 1.5, z:  10, sx: 2,   sy: 1.5, sz: 2   },
    { x: -55, y: 1,   z:   5, sx: 1.5, sy: 1,   sz: 1.5 },
    { x: -60, y: 1.5, z:   0, sx: 2,   sy: 1.5, sz: 2   },
    { x:   0, y: 1,   z:  -5, sx: 1.5, sy: 1,   sz: 1.5 },
    { x:   5, y: 0.75,z: -10, sx: 1,   sy: 0.75,sz: 1   },
    { x: -10, y: 1,   z:  55, sx: 1.5, sy: 1,   sz: 1.5 },
    { x:  35, y: 1,   z:  35, sx: 1.5, sy: 1,   sz: 1.5 },

    // Long fences / corridors
    { x:  70, y: 1.5, z:   0, sx: 0.5, sy: 1.5, sz: 15 },
    { x: -70, y: 1.5, z:   0, sx: 0.5, sy: 1.5, sz: 15 },
    { x:   0, y: 1.5, z:  70, sx: 15,  sy: 1.5, sz: 0.5 },
    { x:   0, y: 1.5, z: -70, sx: 15,  sy: 1.5, sz: 0.5 },

    // Elevated platforms
    { x:  20, y: 2.5, z:  -5, sx: 3, sy: 0.25, sz: 3 },
    { x: -20, y: 2.5, z:   5, sx: 3, sy: 0.25, sz: 3 },

    // Ramps (flat boxes at slight elevation used as step-ups)
    { x:  17, y: 1.25, z:  -5, sx: 1, sy: 0.25, sz: 2 },
    { x: -17, y: 1.25, z:   5, sx: 1, sy: 0.25, sz: 2 }
];

// ---------- Weapon pickups on the map ----------
const INITIAL_WEAPON_PICKUPS = [
    { id: 'w1', weapon: 'pistol',  x:   0, y: 0.5, z:   0 },
    { id: 'w2', weapon: 'shotgun', x:  20, y: 0.5, z:  20 },
    { id: 'w3', weapon: 'rifle',   x: -20, y: 0.5, z: -20 },
    { id: 'w4', weapon: 'sniper',  x:  40, y: 0.5, z:  40 },
    { id: 'w5', weapon: 'rifle',   x: -40, y: 0.5, z:  40 },
    { id: 'w6', weapon: 'shotgun', x:  40, y: 0.5, z: -40 },
    { id: 'w7', weapon: 'sniper',  x: -40, y: 0.5, z: -40 },
    { id: 'w8', weapon: 'pistol',  x:   0, y: 0.5, z:  50 }
];

const players = {};          // socketId -> player
const pickups = {};          // id -> pickup state
INITIAL_WEAPON_PICKUPS.forEach(p => pickups[p.id] = { ...p, available: true, respawnAt: 0 });

const killFeed = [];         // last N kill events
const MAX_KILL_FEED = 10;

// ---------- Helpers ----------
function randSpawn() {
    return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}

function aabbContainsPoint(obs, x, y, z) {
    return (
        x >= obs.x - obs.sx && x <= obs.x + obs.sx &&
        y >= obs.y - obs.sy && y <= obs.y + obs.sy &&
        z >= obs.z - obs.sz && z <= obs.z + obs.sz
    );
}

function raySegmentHitsObstacle(ox, oy, oz, dx, dy, dz, maxDist) {
    // Slab method — returns distance to closest obstacle hit or Infinity
    let closest = Infinity;
    for (const obs of OBSTACLES) {
        const minX = obs.x - obs.sx, maxX = obs.x + obs.sx;
        const minY = obs.y - obs.sy, maxY = obs.y + obs.sy;
        const minZ = obs.z - obs.sz, maxZ = obs.z + obs.sz;

        let tmin = 0, tmax = maxDist;
        for (let axis = 0; axis < 3; axis++) {
            const origin = axis === 0 ? ox : axis === 1 ? oy : oz;
            const dir    = axis === 0 ? dx : axis === 1 ? dy : dz;
            const mn     = axis === 0 ? minX : axis === 1 ? minY : minZ;
            const mx     = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
            if (Math.abs(dir) < 1e-8) {
                if (origin < mn || origin > mx) { tmin = Infinity; break; }
            } else {
                let t1 = (mn - origin) / dir;
                let t2 = (mx - origin) / dir;
                if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) { tmin = Infinity; break; }
            }
        }
        if (tmin >= 0 && tmin < closest) closest = tmin;
    }
    return closest;
}

function hitPlayer(shooter, ox, oy, oz, dx, dy, dz, maxDist, obstacleDist) {
    // Player treated as a vertical capsule ~ 2 units tall, radius 0.5
    let closest = { dist: Infinity, id: null };
    for (const id in players) {
        if (id === shooter.id) continue;
        const p = players[id];
        if (p.dead) continue;
        // Ray-sphere-ish: approximate body by 2 spheres (torso + head)
        const targets = [
            { x: p.x, y: p.y + 0.9, z: p.z, r: 0.6 }, // torso
            { x: p.x, y: p.y + 1.7, z: p.z, r: 0.4 }  // head
        ];
        for (const t of targets) {
            const ex = t.x - ox, ey = t.y - oy, ez = t.z - oz;
            const b = ex * dx + ey * dy + ez * dz;
            if (b < 0) continue;
            const c = ex*ex + ey*ey + ez*ez - b*b;
            if (c > t.r * t.r) continue;
            const thc = Math.sqrt(t.r*t.r - c);
            const tHit = b - thc;
            if (tHit >= 0 && tHit < closest.dist && tHit < maxDist && tHit < obstacleDist) {
                closest = { dist: tHit, id };
            }
        }
    }
    return closest;
}

function makePlayer(id, nickname, color) {
    const sp = randSpawn();
    return {
        id,
        nickname: (nickname || 'player').slice(0, 16),
        color: color || '#ff4444',
        x: sp.x, y: sp.y, z: sp.z,
        vy: 0,
        yaw: 0, pitch: 0,
        moving: false,
        hp: 100,
        kills: 0,
        deaths: 0,
        weapon: 'pistol',
        ammo: WEAPONS.pistol.ammoMax,
        lastShot: 0,
        dead: false,
        respawnAt: 0
    };
}

// ---------- Network ----------
const server = http.createServer((req, res) => {
    // Socket.io handles /socket.io/* internally — don't intercept
    if (req.url && req.url.startsWith('/socket.io/')) return;

    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    if (urlPath === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    const resolved = path.normalize(path.join(CLIENT_DIR, urlPath));
    // Prevent path traversal outside CLIENT_DIR
    if (!resolved.startsWith(CLIENT_DIR)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(resolved, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(resolved).pipe(res);
    });
});

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.on('connection', (socket) => {
    console.log('[+] connected', socket.id);

    socket.on('join', (data) => {
        const player = makePlayer(socket.id, data?.nickname, data?.color);
        players[socket.id] = player;

        socket.emit('init', {
            selfId: socket.id,
            obstacles: OBSTACLES,
            spawnPoints: SPAWN_POINTS,
            mapSize: MAP_SIZE,
            weapons: WEAPONS,
            pickups: Object.values(pickups).filter(p => p.available),
            players: Object.values(players)
        });

        socket.broadcast.emit('player_joined', player);
    });

    socket.on('move', (data) => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        // Trust client position but clamp to map bounds — server runs full validation
        // (authoritative hit detection; movement is trusted for responsiveness in small-scale)
        const L = MAP_SIZE / 2 - 1;
        p.x = Math.max(-L, Math.min(L, +data.x || 0));
        p.y = Math.max(0, Math.min(50, +data.y || 0));
        p.z = Math.max(-L, Math.min(L, +data.z || 0));
        p.vy = +data.vy || 0;
        p.moving = !!data.moving;
    });

    socket.on('rotate', (data) => {
        const p = players[socket.id];
        if (!p) return;
        p.yaw = +data.yaw || 0;
        p.pitch = +data.pitch || 0;
    });

    socket.on('shoot', (data) => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        const w = WEAPONS[p.weapon];
        if (!w) return;
        const now = Date.now();
        const cooldown = 1000 / w.fireRate;
        if (now - p.lastShot < cooldown - 20) return; // small tolerance
        if (p.ammo <= 0) return;
        p.lastShot = now;
        p.ammo -= 1;

        const ox = +data.ox, oy = +data.oy, oz = +data.oz;
        const dx = +data.dx, dy = +data.dy, dz = +data.dz;
        if (!Number.isFinite(ox + oy + oz + dx + dy + dz)) return;

        const shots = [];
        for (let i = 0; i < w.pellets; i++) {
            // Apply spread (deg -> rad)
            const spreadRad = w.spread * Math.PI / 180;
            const ax = (Math.random() - 0.5) * 2 * spreadRad;
            const ay = (Math.random() - 0.5) * 2 * spreadRad;
            // Rotate direction vector by small random angles
            let rdx = dx, rdy = dy, rdz = dz;
            // rotate around Y
            const cy = Math.cos(ax), sy = Math.sin(ax);
            const nx = rdx * cy - rdz * sy;
            const nz = rdx * sy + rdz * cy;
            rdx = nx; rdz = nz;
            // rotate around X (pitch) — use axis perpendicular to forward on XZ plane
            const len = Math.hypot(rdx, rdz) || 1;
            const rx = -rdz / len, rz = rdx / len; // right vector
            const cx = Math.cos(ay), sx = Math.sin(ay);
            // Rodrigues around (rx, 0, rz)
            const d = rdx * rx + rdz * rz;
            const ndx = rdx * cx + (rz * rdy) * sx + rx * d * (1 - cx);
            const ndy = rdy * cx + (rz * rdx - rx * rdz) * sx;
            const ndz = rdz * cx + (-rx * rdy) * sx + rz * d * (1 - cx);
            rdx = ndx; rdy = ndy; rdz = ndz;
            const mag = Math.hypot(rdx, rdy, rdz) || 1;
            rdx /= mag; rdy /= mag; rdz /= mag;

            const maxDist = 200;
            const obsDist = raySegmentHitsObstacle(ox, oy, oz, rdx, rdy, rdz, maxDist);
            const hit = hitPlayer(p, ox, oy, oz, rdx, rdy, rdz, maxDist, obsDist);

            let endX, endY, endZ, victimId = null;
            if (hit.id) {
                endX = ox + rdx * hit.dist;
                endY = oy + rdy * hit.dist;
                endZ = oz + rdz * hit.dist;
                victimId = hit.id;
                // Apply damage
                const victim = players[hit.id];
                if (victim && !victim.dead) {
                    victim.hp -= w.damage;
                    if (victim.hp <= 0) {
                        victim.hp = 0;
                        victim.dead = true;
                        victim.deaths += 1;
                        victim.respawnAt = Date.now() + 5000;
                        p.kills += 1;
                        // Drop their weapon where they died (pickup)
                        const pickupId = 'drop_' + Date.now() + '_' + Math.floor(Math.random()*1000);
                        pickups[pickupId] = {
                            id: pickupId, weapon: victim.weapon,
                            x: victim.x, y: 0.5, z: victim.z,
                            available: true, respawnAt: 0, isDrop: true
                        };
                        io.emit('pickup_spawned', pickups[pickupId]);
                        // Kill feed entry
                        const entry = {
                            killer: p.nickname, killerColor: p.color,
                            victim: victim.nickname, victimColor: victim.color,
                            weapon: p.weapon, t: Date.now()
                        };
                        killFeed.push(entry);
                        if (killFeed.length > MAX_KILL_FEED) killFeed.shift();
                        io.emit('kill', entry);
                        io.emit('player_died', { id: victim.id, killer: p.id });
                    }
                }
            } else if (obsDist < maxDist) {
                endX = ox + rdx * obsDist;
                endY = oy + rdy * obsDist;
                endZ = oz + rdz * obsDist;
            } else {
                endX = ox + rdx * maxDist;
                endY = oy + rdy * maxDist;
                endZ = oz + rdz * maxDist;
            }
            shots.push({ ox, oy, oz, ex: endX, ey: endY, ez: endZ, victimId });
        }

        io.emit('shot_fired', { shooterId: p.id, weapon: p.weapon, shots });
    });

    socket.on('pickup_weapon', (data) => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        const pk = pickups[data?.id];
        if (!pk || !pk.available) return;
        const dx = pk.x - p.x, dz = pk.z - p.z;
        if (dx*dx + dz*dz > 9) return; // must be within 3 units
        p.weapon = pk.weapon;
        p.ammo = WEAPONS[pk.weapon].ammoMax;
        pk.available = false;
        if (pk.isDrop) {
            // Drops disappear on pickup
            io.emit('pickup_removed', { id: pk.id });
            delete pickups[pk.id];
        } else {
            pk.respawnAt = Date.now() + 10000;
            io.emit('pickup_removed', { id: pk.id });
        }
    });

    socket.on('disconnect', () => {
        console.log('[-] disconnected', socket.id);
        delete players[socket.id];
        io.emit('player_left', { id: socket.id });
    });
});

// ---------- Game loop ----------
setInterval(() => {
    const now = Date.now();

    // Respawn players
    for (const id in players) {
        const p = players[id];
        if (p.dead && now >= p.respawnAt) {
            const sp = randSpawn();
            p.x = sp.x; p.y = sp.y; p.z = sp.z;
            p.hp = 100;
            p.dead = false;
            p.vy = 0;
            p.weapon = 'pistol';
            p.ammo = WEAPONS.pistol.ammoMax;
            io.to(id).emit('you_respawned', { x: sp.x, y: sp.y, z: sp.z });
            io.emit('player_respawned', { id: p.id, x: sp.x, y: sp.y, z: sp.z, hp: p.hp });
        }
    }

    // Respawn fixed pickups
    for (const id in pickups) {
        const pk = pickups[id];
        if (!pk.available && !pk.isDrop && now >= pk.respawnAt) {
            pk.available = true;
            io.emit('pickup_spawned', pk);
        }
    }

    // Broadcast state snapshot
    const snapshot = {
        t: now,
        players: Object.values(players).map(p => ({
            id: p.id, nickname: p.nickname, color: p.color,
            x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
            hp: p.hp, weapon: p.weapon, ammo: p.ammo,
            kills: p.kills, deaths: p.deaths,
            moving: p.moving, dead: p.dead
        }))
    };
    io.emit('state', snapshot);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
    console.log('Shooter 3D server listening on :' + PORT + ' (client dir: ' + CLIENT_DIR + ')');
});
