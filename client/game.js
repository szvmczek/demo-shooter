// ============================================================
// Shooter 3D — client (Three.js + Socket.io)
// Third-person multiplayer arena shooter
// ============================================================

/* globals THREE, io */

// ---------- Globals ----------
const CFG = {
    moveSpeed: 6,
    sprintMul: 1.8,
    jumpVel: 7,
    gravity: 20,
    mouseSensitivity: 0.0025,
    cameraDistance: 5,
    cameraHeight: 2.2,
    networkSendRate: 20, // Hz
    interpDelay: 100 // ms — render other players this far in the past
};

const WEAPONS_META = {
    pistol:  { color: 0x888888, length: 0.5, width: 0.1, height: 0.18, displayName: 'PISTOL' },
    shotgun: { color: 0x8B4513, length: 0.9, width: 0.14, height: 0.22, displayName: 'SHOTGUN' },
    rifle:   { color: 0x222222, length: 1.1, width: 0.12, height: 0.18, displayName: 'RIFLE' },
    sniper:  { color: 0x333344, length: 1.4, width: 0.10, height: 0.18, displayName: 'SNIPER', hasScope: true }
};

// ---------- Engine ----------
let scene, camera, renderer;
let clock;
let floorMesh, skyMesh;

// ---------- Local player ----------
const self = {
    id: null,
    nickname: 'Player',
    color: '#ff4444',
    pos: new THREE.Vector3(0, 1.5, 0),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    onGround: true,
    hp: 100,
    kills: 0,
    deaths: 0,
    weapon: 'pistol',
    ammo: 12,
    dead: false,
    walkPhase: 0,
    lastShot: 0,
    recoilKick: 0
};

// ---------- Other players ----------
const others = {}; // id -> { mesh, nameTag, state buffer, targetPos, targetYaw, ... }

// ---------- Map data (from server) ----------
let obstacles = []; // [{x,y,z,sx,sy,sz, mesh}]
let weaponPickups = {}; // id -> { id, weapon, x, y, z, mesh, available }
let spawnPoints = [];
let serverWeapons = null;
let MAP_SIZE = 200;

// ---------- Input ----------
const keys = {};
let mouseDown = false;
let pointerLocked = false;

// ---------- Networking ----------
let socket = null;
let lastNetSend = 0;
let lastStateTime = 0;

// ---------- HUD refs ----------
const dom = {};

// ---------- Effects pool ----------
const activeEffects = []; // { mesh, until }
const activeBullets = []; // { mesh, from, to, t, duration }
const activeMuzzleFlashes = []; // { mesh, until }

// ---------- Kill feed ----------
let killFeedEntries = [];

// ---------- Audio (optional, simple beeps) ----------
// (omitted to keep deps zero — could add WebAudio beeps here)

// ============================================================
// Start screen
// ============================================================
function setupStartScreen() {
    dom.startScreen = document.getElementById('start-screen');
    dom.nickInput = document.getElementById('nickname');
    dom.serverInput = document.getElementById('server-url');
    dom.playBtn = document.getElementById('play-btn');
    dom.skinPicker = document.getElementById('skin-picker');
    dom.hud = document.getElementById('hud');
    dom.deathOverlay = document.getElementById('death-overlay');
    dom.deathTimer = document.getElementById('death-timer');
    dom.hpFill = document.getElementById('hp-fill');
    dom.hpText = document.getElementById('hp-text');
    dom.weaponName = document.getElementById('weapon-name');
    dom.ammoText = document.getElementById('ammo-text');
    dom.killFeed = document.getElementById('kill-feed');
    dom.minimap = document.getElementById('minimap');
    dom.minimapCtx = dom.minimap.getContext('2d');
    dom.lbBody = document.getElementById('lb-body');
    dom.hint = document.getElementById('hint');
    dom.connStatus = document.getElementById('connection-status');

    // Skin selection
    const skins = document.querySelectorAll('.skin');
    skins[0].classList.add('selected');
    skins.forEach(s => {
        s.addEventListener('click', () => {
            skins.forEach(x => x.classList.remove('selected'));
            s.classList.add('selected');
            self.color = s.dataset.color;
        });
    });

    // Random default nickname
    dom.nickInput.value = 'Player' + Math.floor(Math.random() * 1000);

    // Default server URL: use same origin if served via http(s); otherwise (file://) fall back to localhost
    if (!dom.serverInput.value) {
        const proto = window.location.protocol;
        if (proto === 'http:' || proto === 'https:') {
            dom.serverInput.value = window.location.origin;
        } else {
            dom.serverInput.value = 'http://localhost:3000';
        }
    }

    dom.playBtn.addEventListener('click', startGame);
    dom.nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startGame();
    });
}

function startGame() {
    self.nickname = (dom.nickInput.value || 'Player').slice(0, 16);
    const proto = window.location.protocol;
    const defaultUrl = (proto === 'http:' || proto === 'https:') ? window.location.origin : 'http://localhost:3000';
    const url = dom.serverInput.value.trim() || defaultUrl;

    dom.startScreen.classList.add('hidden');
    dom.hud.classList.remove('hidden');
    dom.connStatus.textContent = 'Connecting...';

    initThree();
    connectSocket(url);
    setupInput();
    animate();
}

// ============================================================
// Three.js setup
// ============================================================
function initThree() {
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9ec6ff, 80, 220);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('game-container').appendChild(renderer.domElement);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 300;
    scene.add(sun);

    // Hemisphere tint
    const hemi = new THREE.HemisphereLight(0x88aaff, 0x44552b, 0.35);
    scene.add(hemi);

    // Sky gradient (large inverted sphere)
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
            topColor:    { value: new THREE.Color(0x4a7fb8) },
            bottomColor: { value: new THREE.Color(0xe4eeff) },
            offset:      { value: 50 },
            exponent:    { value: 0.6 }
        },
        vertexShader: `
            varying vec3 vWorldPos;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 bottomColor;
            uniform float offset;
            uniform float exponent;
            varying vec3 vWorldPos;
            void main() {
                float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
                gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
            }
        `
    });
    skyMesh = new THREE.Mesh(skyGeo, skyMat);
    scene.add(skyMesh);

    // Floor with procedural grass texture
    const grassTex = makeGrassTexture();
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(40, 40);
    const floorGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
    const floorMat = new THREE.MeshLambertMaterial({ map: grassTex });
    floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function makeGrassTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3d6b2d';
    ctx.fillRect(0, 0, 128, 128);
    // Speckle
    for (let i = 0; i < 800; i++) {
        const x = Math.random() * 128, y = Math.random() * 128;
        const g = 30 + Math.floor(Math.random() * 90);
        const r = 20 + Math.floor(Math.random() * 40);
        ctx.fillStyle = `rgb(${r},${g},${Math.floor(Math.random()*30)})`;
        ctx.fillRect(x, y, 2, 2);
    }
    // Darker blades
    for (let i = 0; i < 250; i++) {
        const x = Math.random() * 128, y = Math.random() * 128;
        ctx.fillStyle = `rgba(20,50,15,${0.15 + Math.random() * 0.3})`;
        ctx.fillRect(x, y, 1, 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
}

// ============================================================
// World build — obstacles & pickups
// ============================================================
function buildObstacles(list) {
    obstacles = [];
    // Shared materials for performance
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xb8a488 });
    const crateMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const platMat = new THREE.MeshLambertMaterial({ color: 0x8899aa });

    for (const o of list) {
        const geo = new THREE.BoxGeometry(o.sx * 2, o.sy * 2, o.sz * 2);
        let mat = wallMat;
        // Heuristic visual classification
        const maxDim = Math.max(o.sx, o.sy, o.sz);
        const minDim = Math.min(o.sx, o.sy, o.sz);
        if (minDim <= 0.5 && maxDim >= 10) mat = fenceMat;
        else if (o.sy < 0.5) mat = platMat;
        else if (o.sx <= 2.5 && o.sy <= 2 && o.sz <= 2.5) mat = crateMat;

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(o.x, o.y, o.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);

        obstacles.push({
            x: o.x, y: o.y, z: o.z,
            sx: o.sx, sy: o.sy, sz: o.sz,
            mesh
        });
    }
}

function buildPickups(pickupList) {
    for (const pk of pickupList) {
        addPickup(pk);
    }
}

function addPickup(pk) {
    const group = new THREE.Group();
    const weaponMesh = buildWeaponMesh(pk.weapon);
    group.add(weaponMesh);
    // Floating glow base
    const baseGeo = new THREE.RingGeometry(0.5, 0.7, 24);
    const baseMat = new THREE.MeshBasicMaterial({
        color: 0xffcc55, transparent: true, opacity: 0.6, side: THREE.DoubleSide
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.4;
    group.add(base);

    group.position.set(pk.x, pk.y, pk.z);
    scene.add(group);

    weaponPickups[pk.id] = {
        id: pk.id, weapon: pk.weapon,
        x: pk.x, y: pk.y, z: pk.z,
        mesh: group, available: true
    };
}

function removePickup(id) {
    const pk = weaponPickups[id];
    if (!pk) return;
    scene.remove(pk.mesh);
    pk.mesh.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose && obj.material.dispose();
    });
    delete weaponPickups[id];
}

// ============================================================
// Weapon mesh (held in hand or on ground)
// ============================================================
function buildWeaponMesh(type) {
    const meta = WEAPONS_META[type] || WEAPONS_META.pistol;
    const group = new THREE.Group();

    const bodyGeo = new THREE.BoxGeometry(meta.width, meta.height, meta.length);
    const bodyMat = new THREE.MeshLambertMaterial({ color: meta.color });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    group.add(body);

    // Grip
    const gripGeo = new THREE.BoxGeometry(meta.width * 0.9, meta.height * 1.5, meta.length * 0.2);
    const grip = new THREE.Mesh(gripGeo, new THREE.MeshLambertMaterial({ color: 0x222222 }));
    grip.position.set(0, -meta.height, -meta.length * 0.3);
    group.add(grip);

    // Barrel tip for muzzle attachment
    const muzzleGeo = new THREE.CylinderGeometry(meta.width * 0.3, meta.width * 0.3, meta.length * 0.2, 8);
    const muzzle = new THREE.Mesh(muzzleGeo, new THREE.MeshLambertMaterial({ color: 0x111111 }));
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0, meta.length * 0.55);
    group.add(muzzle);

    if (meta.hasScope) {
        const scopeGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.35, 12);
        const scope = new THREE.Mesh(scopeGeo, new THREE.MeshLambertMaterial({ color: 0x000000 }));
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, meta.height, -meta.length * 0.1);
        group.add(scope);
    }

    // Record muzzle tip local offset for flash spawning
    group.userData.muzzleOffset = new THREE.Vector3(0, 0, meta.length * 0.7);
    group.userData.weaponType = type;
    return group;
}

// ============================================================
// Player model (humanoid from primitives)
// ============================================================
function buildPlayerModel(color) {
    const group = new THREE.Group();
    const colorObj = new THREE.Color(color);

    const bodyMat = new THREE.MeshLambertMaterial({ color: colorObj });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x222a35 });
    const skinMat = new THREE.MeshLambertMaterial({ color: 0xf0c8a0 });

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), bodyMat);
    torso.position.y = 1.1;
    torso.castShadow = true;
    group.add(torso);

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), skinMat);
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(head);

    // Arms (cylinders)
    const armGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8);
    const armL = new THREE.Mesh(armGeo, bodyMat);
    armL.position.set(-0.45, 1.1, 0);
    armL.castShadow = true;
    group.add(armL);

    const armR = new THREE.Mesh(armGeo, bodyMat);
    armR.position.set(0.45, 1.1, 0);
    armR.castShadow = true;
    group.add(armR);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.7, 8);
    const legL = new THREE.Mesh(legGeo, darkMat);
    legL.position.set(-0.2, 0.35, 0);
    legL.castShadow = true;
    group.add(legL);

    const legR = new THREE.Mesh(legGeo, darkMat);
    legR.position.set(0.2, 0.35, 0);
    legR.castShadow = true;
    group.add(legR);

    // Weapon holder in right hand
    const weaponHolder = new THREE.Group();
    weaponHolder.position.set(0.5, 1.1, 0.35);
    group.add(weaponHolder);

    // Nametag sprite (made after caller knows nickname)
    group.userData = { torso, head, armL, armR, legL, legR, weaponHolder, weaponMesh: null };
    return group;
}

function makeNameTag(text, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 28px Segoe UI, sans-serif';
    ctx.fillStyle = color || '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(text, 128, 32);
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.8, 0.45, 1);
    sprite.position.y = 2.3;
    return sprite;
}

function setPlayerWeapon(playerGroup, weaponType) {
    const ud = playerGroup.userData;
    if (ud.weaponMesh) {
        ud.weaponHolder.remove(ud.weaponMesh);
        ud.weaponMesh.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose && o.material.dispose();
        });
    }
    const w = buildWeaponMesh(weaponType);
    w.scale.set(1, 1, 1);
    ud.weaponMesh = w;
    ud.weaponHolder.add(w);
}

// ============================================================
// Local player setup (created after server init)
// ============================================================
let selfModel = null;

function spawnSelf(x, y, z) {
    self.pos.set(x, y, z);
    if (!selfModel) {
        selfModel = buildPlayerModel(self.color);
        scene.add(selfModel);
        setPlayerWeapon(selfModel, self.weapon);
    }
    selfModel.position.copy(self.pos);
}

// ============================================================
// Collision — AABB slide vs obstacles, plus step-up
// ============================================================
const PLAYER_RADIUS = 0.35;
const PLAYER_HEIGHT = 1.8;
const STEP_HEIGHT = 0.45;

function collideMove(pos, delta) {
    // pos is feet position (y = 0 when on floor). Treat player as AABB.
    // Move each axis separately — slide on collision.
    const next = pos.clone();

    // X axis
    next.x += delta.x;
    if (collidesAt(next.x, next.y, next.z)) {
        // try step-up along X
        const stepped = next.clone(); stepped.y += STEP_HEIGHT;
        if (!collidesAt(stepped.x, stepped.y, stepped.z)) {
            next.y = stepped.y;
        } else {
            next.x -= delta.x;
        }
    }
    // Z axis
    next.z += delta.z;
    if (collidesAt(next.x, next.y, next.z)) {
        const stepped = next.clone(); stepped.y += STEP_HEIGHT;
        if (!collidesAt(stepped.x, stepped.y, stepped.z)) {
            next.y = stepped.y;
        } else {
            next.z -= delta.z;
        }
    }
    // Y axis
    next.y += delta.y;
    if (next.y < 0) { next.y = 0; self.vel.y = 0; self.onGround = true; }
    if (collidesAt(next.x, next.y, next.z)) {
        // Top collision — bump
        if (delta.y > 0) { self.vel.y = 0; }
        else {
            // Landed on top of something — find the highest top below
            const top = highestTopBelow(next.x, next.z, pos.y + PLAYER_HEIGHT);
            if (top !== null) {
                next.y = top;
                self.vel.y = 0;
                self.onGround = true;
            } else {
                next.y -= delta.y;
            }
        }
    } else {
        // Check if feet are now above an obstacle top — allow standing
        // Only snap down if we were previously grounded or moving down slowly
        const top = highestTopBelow(next.x, next.z, next.y);
        if (top !== null && next.y - top < 0.05 && delta.y <= 0) {
            next.y = top;
            self.vel.y = 0;
            self.onGround = true;
        } else if (Math.abs(next.y) > 0.01) {
            self.onGround = false;
        }
    }

    // Clamp map bounds
    const L = MAP_SIZE / 2 - 1;
    if (next.x < -L) next.x = -L;
    if (next.x >  L) next.x =  L;
    if (next.z < -L) next.z = -L;
    if (next.z >  L) next.z =  L;

    pos.copy(next);
}

function collidesAt(x, y, z) {
    // Player AABB: x±r, y..y+h, z±r
    const r = PLAYER_RADIUS;
    const yMin = y, yMax = y + PLAYER_HEIGHT;
    for (const o of obstacles) {
        const oxMin = o.x - o.sx, oxMax = o.x + o.sx;
        const oyMin = o.y - o.sy, oyMax = o.y + o.sy;
        const ozMin = o.z - o.sz, ozMax = o.z + o.sz;
        if (x + r < oxMin || x - r > oxMax) continue;
        if (z + r < ozMin || z - r > ozMax) continue;
        if (yMax < oyMin || yMin > oyMax) continue;
        return true;
    }
    return false;
}

function highestTopBelow(x, z, y) {
    // Returns top surface Y of any obstacle directly under (x,z) that is <= y
    const r = PLAYER_RADIUS;
    let best = null;
    for (const o of obstacles) {
        const oxMin = o.x - o.sx, oxMax = o.x + o.sx;
        const ozMin = o.z - o.sz, ozMax = o.z + o.sz;
        if (x + r < oxMin || x - r > oxMax) continue;
        if (z + r < ozMin || z - r > ozMax) continue;
        const top = o.y + o.sy;
        if (top <= y + 0.5 && (best === null || top > best)) best = top;
    }
    return best;
}

// ============================================================
// Input
// ============================================================
function setupInput() {
    document.addEventListener('keydown', (e) => {
        keys[e.code] = true;
        if (e.code === 'KeyE') tryPickup();
    });
    document.addEventListener('keyup', (e) => {
        keys[e.code] = false;
    });

    renderer.domElement.addEventListener('mousedown', (e) => {
        if (!pointerLocked) {
            renderer.domElement.requestPointerLock();
            return;
        }
        if (e.button === 0) mouseDown = true;
    });
    document.addEventListener('mouseup', (e) => {
        if (e.button === 0) mouseDown = false;
    });

    document.addEventListener('mousemove', (e) => {
        if (!pointerLocked) return;
        self.yaw   -= e.movementX * CFG.mouseSensitivity;
        self.pitch -= e.movementY * CFG.mouseSensitivity;
        const maxPitch = Math.PI / 2 - 0.05;
        if (self.pitch >  maxPitch) self.pitch =  maxPitch;
        if (self.pitch < -maxPitch) self.pitch = -maxPitch;
    });

    document.addEventListener('pointerlockchange', () => {
        pointerLocked = document.pointerLockElement === renderer.domElement;
    });
}

function tryPickup() {
    // Find nearest available pickup within range
    let best = null, bestDist = 9; // 3 units
    for (const id in weaponPickups) {
        const pk = weaponPickups[id];
        if (!pk.available) continue;
        const dx = pk.x - self.pos.x;
        const dz = pk.z - self.pos.z;
        const d = dx*dx + dz*dz;
        if (d < bestDist) { bestDist = d; best = pk; }
    }
    if (best && socket) socket.emit('pickup_weapon', { id: best.id });
}

// ============================================================
// Networking
// ============================================================
function connectSocket(url) {
    socket = io(url, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        dom.connStatus.textContent = 'Connected';
        socket.emit('join', { nickname: self.nickname, color: self.color });
    });

    socket.on('disconnect', () => {
        dom.connStatus.textContent = 'Disconnected';
    });

    socket.on('connect_error', (err) => {
        dom.connStatus.textContent = 'Connection failed: ' + err.message;
    });

    socket.on('init', (data) => {
        self.id = data.selfId;
        MAP_SIZE = data.mapSize;
        spawnPoints = data.spawnPoints;
        serverWeapons = data.weapons;

        // Resize floor to server map size
        floorMesh.geometry.dispose();
        floorMesh.geometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);

        buildObstacles(data.obstacles);
        buildPickups(data.pickups);

        // Place self based on server's initial player record
        const mine = data.players.find(p => p.id === self.id);
        if (mine) {
            self.hp = mine.hp;
            self.weapon = mine.weapon;
            self.ammo = mine.ammo;
            spawnSelf(mine.x, mine.y, mine.z); // server y is feet y
        } else {
            spawnSelf(0, 0, 0);
        }

        // Other players
        for (const p of data.players) {
            if (p.id !== self.id) addOther(p);
        }
        updateHUD();
    });

    socket.on('player_joined', (p) => {
        if (p.id !== self.id) addOther(p);
    });

    socket.on('player_left', (d) => removeOther(d.id));

    socket.on('state', (snapshot) => {
        lastStateTime = performance.now();
        for (const p of snapshot.players) {
            if (p.id === self.id) {
                // Authoritative HP/ammo/weapon/kills/deaths
                self.hp = p.hp;
                self.ammo = p.ammo;
                if (p.weapon !== self.weapon) {
                    self.weapon = p.weapon;
                    if (selfModel) setPlayerWeapon(selfModel, self.weapon);
                }
                self.kills = p.kills;
                self.deaths = p.deaths;
                self.dead = p.dead;
                continue;
            }
            let o = others[p.id];
            if (!o) { o = addOther(p); }
            // Push state into buffer for interpolation
            o.buffer.push({ t: lastStateTime, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, moving: p.moving, dead: p.dead });
            // Trim to last 1s
            while (o.buffer.length > 60) o.buffer.shift();
            o.data = p;
            // Update weapon if changed
            if (p.weapon !== o.weapon) {
                o.weapon = p.weapon;
                setPlayerWeapon(o.mesh, p.weapon);
            }
        }
        updateLeaderboard(snapshot.players);
        updateHUD();
    });

    socket.on('shot_fired', (data) => {
        for (const s of data.shots) {
            spawnBulletTracer(s.ox, s.oy, s.oz, s.ex, s.ey, s.ez);
            spawnHitSpark(s.ex, s.ey, s.ez);
        }
        // Muzzle flash at shooter
        if (data.shooterId === self.id && selfModel) {
            spawnMuzzleFlashAt(selfModel.userData.weaponMesh);
            self.recoilKick = 1;
        } else {
            const o = others[data.shooterId];
            if (o && o.mesh.userData.weaponMesh) {
                spawnMuzzleFlashAt(o.mesh.userData.weaponMesh);
            }
        }
    });

    socket.on('kill', (entry) => {
        addKillFeed(entry);
    });

    socket.on('player_died', (d) => {
        if (d.id === self.id) onSelfDied();
    });

    socket.on('you_respawned', (d) => {
        self.pos.set(d.x, 0, d.z);
        self.vel.set(0, 0, 0);
        self.dead = false;
        dom.deathOverlay.classList.add('hidden');
    });

    socket.on('player_respawned', (d) => {
        const o = others[d.id];
        if (o) {
            o.buffer = [];
        }
    });

    socket.on('pickup_spawned', (pk) => {
        if (weaponPickups[pk.id]) return;
        addPickup(pk);
    });

    socket.on('pickup_removed', (d) => {
        removePickup(d.id);
    });
}

function addOther(p) {
    const mesh = buildPlayerModel(p.color);
    mesh.position.set(p.x, p.y - 1.5, p.z);
    mesh.rotation.y = p.yaw;
    setPlayerWeapon(mesh, p.weapon || 'pistol');
    const tag = makeNameTag(p.nickname, p.color);
    mesh.add(tag);
    scene.add(mesh);

    const o = {
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        weapon: p.weapon,
        mesh,
        buffer: [],
        walkPhase: 0,
        data: p
    };
    others[p.id] = o;
    return o;
}

function removeOther(id) {
    const o = others[id];
    if (!o) return;
    scene.remove(o.mesh);
    o.mesh.traverse(x => {
        if (x.geometry) x.geometry.dispose();
        if (x.material) {
            if (x.material.map) x.material.map.dispose();
            x.material.dispose && x.material.dispose();
        }
    });
    delete others[id];
}

function sendMoveRotate() {
    if (!socket || !socket.connected) return;
    // Server stores y as feet + 1.5 convention? We send feet y. Server treats whatever it gets.
    // Keep consistent: send feet y + 1.5 (body center) so server sphere hit detection works (torso at y+0.9, head at y+1.7 from feet).
    // We'll send feet y directly — server's hit-detection adds +0.9 and +1.7, matching our feet-origin model.
    socket.emit('move', {
        x: self.pos.x, y: self.pos.y, z: self.pos.z,
        vy: self.vel.y,
        moving: isMoving()
    });
    socket.emit('rotate', { yaw: self.yaw, pitch: self.pitch });
}

// ============================================================
// Game loop
// ============================================================
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    if (!self.dead) {
        updateLocalPlayer(dt);
        if (mouseDown) tryShoot(now);
    } else {
        // Death: slowly tilt camera and show respawn timer
        // (camera handled in updateCamera)
    }

    updateOthers(now);
    updatePickupAnimations(dt);
    updateEffects(now, dt);
    updateCamera(dt);

    // Throttled network sends
    if (now - lastNetSend > 1000 / CFG.networkSendRate) {
        lastNetSend = now;
        sendMoveRotate();
    }

    renderer.render(scene, camera);
    drawMinimap();
}

function isMoving() {
    return keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD;
}

function updateLocalPlayer(dt) {
    // Horizontal input relative to camera yaw
    let fx = 0, fz = 0;
    if (keys.KeyW) fz -= 1;
    if (keys.KeyS) fz += 1;
    if (keys.KeyA) fx -= 1;
    if (keys.KeyD) fx += 1;
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }

    const speed = CFG.moveSpeed * (keys.ShiftLeft || keys.ShiftRight ? CFG.sprintMul : 1);
    const cy = Math.cos(self.yaw), sy = Math.sin(self.yaw);
    // Forward vector of player (yaw=0 faces -Z)
    const wx =  fx * cy + fz * sy;
    const wz = -fx * sy + fz * cy;

    const delta = new THREE.Vector3(wx * speed * dt, 0, wz * speed * dt);

    // Jump
    if (keys.Space && self.onGround) {
        self.vel.y = CFG.jumpVel;
        self.onGround = false;
    }
    // Gravity
    self.vel.y -= CFG.gravity * dt;
    delta.y = self.vel.y * dt;

    collideMove(self.pos, delta);

    // Walking phase
    if (len > 0 && self.onGround) {
        self.walkPhase += dt * 10 * (speed / CFG.moveSpeed);
    } else {
        self.walkPhase *= 0.8;
    }

    // Update self model
    if (selfModel) {
        selfModel.position.copy(self.pos);
        selfModel.rotation.y = self.yaw;
        animateLegs(selfModel, self.walkPhase);
    }

    // Hint for pickup
    let near = null, nd = 9;
    for (const id in weaponPickups) {
        const pk = weaponPickups[id];
        if (!pk.available) continue;
        const dx = pk.x - self.pos.x, dz = pk.z - self.pos.z;
        const d = dx*dx + dz*dz;
        if (d < nd) { nd = d; near = pk; }
    }
    if (near) dom.hint.classList.remove('hidden');
    else dom.hint.classList.add('hidden');
}

function animateLegs(model, phase) {
    const ud = model.userData;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    if (ud.legL) ud.legL.rotation.x =  s * 0.7;
    if (ud.legR) ud.legR.rotation.x = -s * 0.7;
    if (ud.armL) ud.armL.rotation.x = -s * 0.5;
    if (ud.armR) ud.armR.rotation.x =  s * 0.3;
}

function updateOthers(now) {
    const renderT = now - CFG.interpDelay;
    for (const id in others) {
        const o = others[id];
        const buf = o.buffer;
        if (buf.length === 0) continue;
        // Find two snapshots surrounding renderT
        let before = buf[0], after = buf[buf.length - 1];
        for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i].t <= renderT && buf[i + 1].t >= renderT) {
                before = buf[i];
                after = buf[i + 1];
                break;
            }
        }
        let x, y, z, yaw;
        if (before === after) {
            x = after.x; y = after.y; z = after.z; yaw = after.yaw;
        } else {
            const t = (renderT - before.t) / (after.t - before.t);
            const tc = Math.max(0, Math.min(1, t));
            x = before.x + (after.x - before.x) * tc;
            y = before.y + (after.y - before.y) * tc;
            z = before.z + (after.z - before.z) * tc;
            // yaw lerp via shortest arc
            let dy = after.yaw - before.yaw;
            while (dy >  Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            yaw = before.yaw + dy * tc;
        }
        // y from server is feet y
        o.mesh.position.set(x, y, z);
        o.mesh.rotation.y = yaw;
        o.mesh.visible = !(o.data && o.data.dead);
        // Walking animation
        if (after.moving && !after.dead) {
            o.walkPhase = (o.walkPhase || 0) + 0.16;
            animateLegs(o.mesh, o.walkPhase);
        } else {
            if (o.walkPhase) o.walkPhase *= 0.8;
            animateLegs(o.mesh, o.walkPhase);
        }
    }
}

function updatePickupAnimations(dt) {
    const t = performance.now() * 0.002;
    for (const id in weaponPickups) {
        const pk = weaponPickups[id];
        if (!pk.mesh) continue;
        pk.mesh.rotation.y += dt * 1.2;
        pk.mesh.position.y = pk.y + Math.sin(t + pk.x) * 0.15;
    }
}

function updateCamera(dt) {
    if (!selfModel) return;
    // TPS: camera follows behind player, rotated by yaw+pitch
    const dist = CFG.cameraDistance;
    const height = CFG.cameraHeight;
    const cp = Math.cos(self.pitch), sp = Math.sin(self.pitch);
    const cy = Math.cos(self.yaw),   sy = Math.sin(self.yaw);

    // Offset behind player: forward is -Z in player's local, so behind is +Z local
    // Rotate that by yaw, and raise by pitch
    const offset = new THREE.Vector3(0, height + dist * sp, dist * cp);
    // Apply yaw rotation (around world Y)
    const ox =  offset.x * cy + offset.z * sy;
    const oz = -offset.x * sy + offset.z * cy;

    const target = new THREE.Vector3(
        self.pos.x + ox,
        self.pos.y + offset.y,
        self.pos.z + oz
    );

    // Simple obstacle avoidance: if camera would be inside a wall, bring it closer
    const headPos = new THREE.Vector3(self.pos.x, self.pos.y + 1.6, self.pos.z);
    const dir = new THREE.Vector3().subVectors(target, headPos);
    const len = dir.length();
    dir.normalize();
    let d = len;
    for (const o of obstacles) {
        const t = raySlabAABB(headPos.x, headPos.y, headPos.z, dir.x, dir.y, dir.z, len, o);
        if (t < d) d = t;
    }
    d = Math.max(0.8, d - 0.3);
    camera.position.copy(headPos).addScaledVector(dir, d);

    // Look-at: a point in front of the player (so crosshair aims at what the ray hits)
    const look = new THREE.Vector3(
        self.pos.x - Math.sin(self.yaw) * Math.cos(self.pitch) * 20,
        self.pos.y + 1.6 + Math.sin(self.pitch) * 20,
        self.pos.z - Math.cos(self.yaw) * Math.cos(self.pitch) * 20
    );

    // Apply recoil kick (upward pitch add)
    if (self.recoilKick > 0) {
        self.recoilKick -= dt * 5;
        if (self.recoilKick < 0) self.recoilKick = 0;
        look.y += self.recoilKick * 2;
    }

    camera.lookAt(look);

    // Death camera: tip over
    if (self.dead) {
        camera.position.y = Math.max(0.3, camera.position.y - dt * 3);
        camera.rotation.z += dt * 0.5;
        if (camera.rotation.z > 1) camera.rotation.z = 1;
    }
}

function raySlabAABB(ox, oy, oz, dx, dy, dz, maxT, o) {
    const minX = o.x - o.sx, maxX = o.x + o.sx;
    const minY = o.y - o.sy, maxY = o.y + o.sy;
    const minZ = o.z - o.sz, maxZ = o.z + o.sz;
    let tmin = 0, tmax = maxT;
    const axes = [[ox, dx, minX, maxX], [oy, dy, minY, maxY], [oz, dz, minZ, maxZ]];
    for (const [origin, dir, mn, mx] of axes) {
        if (Math.abs(dir) < 1e-8) {
            if (origin < mn || origin > mx) return Infinity;
        } else {
            let t1 = (mn - origin) / dir, t2 = (mx - origin) / dir;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            if (t1 > tmin) tmin = t1;
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) return Infinity;
        }
    }
    return tmin >= 0 ? tmin : Infinity;
}

// ============================================================
// Shooting
// ============================================================
function tryShoot(now) {
    if (!serverWeapons) return;
    const w = serverWeapons[self.weapon];
    if (!w) return;
    const cooldown = 1000 / w.fireRate;
    if (now - self.lastShot < cooldown) return;
    if (self.ammo <= 0) return;
    self.lastShot = now;

    // Ray origin: camera position; direction: camera forward
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);

    socket.emit('shoot', {
        ox: origin.x, oy: origin.y, oz: origin.z,
        dx: dir.x,   dy: dir.y,   dz: dir.z
    });
}

// ============================================================
// Visual effects
// ============================================================
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffff88, transparent: true, opacity: 0.85 });

function spawnBulletTracer(ox, oy, oz, ex, ey, ez) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([ox, oy, oz, ex, ey, ez], 3));
    const line = new THREE.Line(geo, tracerMat.clone());
    line.material.transparent = true;
    line.material.opacity = 0.9;
    scene.add(line);
    activeBullets.push({ mesh: line, until: performance.now() + 120 });
}

function spawnHitSpark(x, y, z) {
    const geo = new THREE.SphereGeometry(0.15, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 1 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    scene.add(m);
    activeEffects.push({ mesh: m, until: performance.now() + 250 });
}

function spawnMuzzleFlashAt(weaponMesh) {
    if (!weaponMesh) return;
    const off = weaponMesh.userData.muzzleOffset || new THREE.Vector3(0, 0, 0.7);
    const geo = new THREE.SphereGeometry(0.18, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 1 });
    const m = new THREE.Mesh(geo, mat);
    weaponMesh.add(m);
    m.position.copy(off);
    activeMuzzleFlashes.push({ mesh: m, parent: weaponMesh, until: performance.now() + 80 });
}

function updateEffects(now, dt) {
    for (let i = activeBullets.length - 1; i >= 0; i--) {
        const b = activeBullets[i];
        const life = (b.until - now) / 120;
        if (life <= 0) {
            scene.remove(b.mesh);
            b.mesh.geometry.dispose();
            b.mesh.material.dispose();
            activeBullets.splice(i, 1);
        } else {
            b.mesh.material.opacity = Math.max(0, life);
        }
    }
    for (let i = activeEffects.length - 1; i >= 0; i--) {
        const e = activeEffects[i];
        const life = (e.until - now) / 250;
        if (life <= 0) {
            scene.remove(e.mesh);
            e.mesh.geometry.dispose();
            e.mesh.material.dispose();
            activeEffects.splice(i, 1);
        } else {
            e.mesh.material.opacity = life;
            e.mesh.scale.setScalar(1 + (1 - life) * 0.5);
        }
    }
    for (let i = activeMuzzleFlashes.length - 1; i >= 0; i--) {
        const mf = activeMuzzleFlashes[i];
        if (now >= mf.until) {
            if (mf.parent) mf.parent.remove(mf.mesh);
            mf.mesh.geometry.dispose();
            mf.mesh.material.dispose();
            activeMuzzleFlashes.splice(i, 1);
        }
    }
}

// ============================================================
// Death
// ============================================================
function onSelfDied() {
    self.dead = true;
    dom.deathOverlay.classList.remove('hidden');
    let s = 5;
    dom.deathTimer.textContent = 'Respawn in ' + s + '...';
    const iv = setInterval(() => {
        s -= 1;
        if (s <= 0) { clearInterval(iv); return; }
        dom.deathTimer.textContent = 'Respawn in ' + s + '...';
    }, 1000);
}

// ============================================================
// HUD: HP, ammo, kill feed, leaderboard
// ============================================================
function updateHUD() {
    dom.hpFill.style.width = Math.max(0, self.hp) + '%';
    dom.hpText.textContent = Math.max(0, Math.round(self.hp));
    const meta = WEAPONS_META[self.weapon] || WEAPONS_META.pistol;
    dom.weaponName.textContent = meta.displayName;
    const max = serverWeapons ? serverWeapons[self.weapon].ammoMax : 0;
    dom.ammoText.textContent = self.ammo + ' / ' + max;
}

function addKillFeed(entry) {
    killFeedEntries.push(entry);
    if (killFeedEntries.length > 5) killFeedEntries.shift();

    dom.killFeed.innerHTML = '';
    for (const e of killFeedEntries) {
        const div = document.createElement('div');
        div.className = 'kill-entry';
        const killerSpan = `<span class="killer" style="color:${escapeColor(e.killerColor)}">${escapeHtml(e.killer)}</span>`;
        const weaponSpan = `<span class="weapon-ico">[${escapeHtml(e.weapon)}]</span>`;
        const victimSpan = `<span class="victim" style="color:${escapeColor(e.victimColor)}">${escapeHtml(e.victim)}</span>`;
        div.innerHTML = `${killerSpan} ${weaponSpan} ${victimSpan}`;
        dom.killFeed.appendChild(div);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeColor(c) {
    return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#ffffff';
}

function updateLeaderboard(playersArr) {
    const sorted = [...playersArr].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    dom.lbBody.innerHTML = '';
    for (const p of sorted) {
        const tr = document.createElement('tr');
        if (p.id === self.id) tr.className = 'lb-self';
        tr.innerHTML = `
            <td><span class="lb-dot" style="background:${escapeColor(p.color)}"></span><span class="lb-name">${escapeHtml(p.nickname)}</span></td>
            <td>${p.kills}</td>
            <td>${p.deaths}</td>
        `;
        dom.lbBody.appendChild(tr);
    }
}

// ============================================================
// Minimap
// ============================================================
function drawMinimap() {
    const ctx = dom.minimapCtx;
    const size = dom.minimap.width;
    const r = size / 2;
    ctx.clearRect(0, 0, size, size);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();

    // Background
    ctx.fillStyle = '#1a2d18';
    ctx.fillRect(0, 0, size, size);

    const scale = size / MAP_SIZE;

    // Obstacles
    ctx.fillStyle = 'rgba(180,160,130,0.6)';
    for (const o of obstacles) {
        const cx = r + (o.x - self.pos.x) * scale;
        const cy = r + (o.z - self.pos.z) * scale;
        const w = Math.max(1, o.sx * 2 * scale);
        const h = Math.max(1, o.sz * 2 * scale);
        ctx.fillRect(cx - w/2, cy - h/2, w, h);
    }

    // Pickups
    ctx.fillStyle = '#ffcc55';
    for (const id in weaponPickups) {
        const pk = weaponPickups[id];
        if (!pk.available) continue;
        const cx = r + (pk.x - self.pos.x) * scale;
        const cy = r + (pk.z - self.pos.z) * scale;
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Other players
    for (const id in others) {
        const o = others[id];
        if (o.data && o.data.dead) continue;
        const cx = r + (o.mesh.position.x - self.pos.x) * scale;
        const cy = r + (o.mesh.position.z - self.pos.z) * scale;
        ctx.fillStyle = escapeColor(o.color);
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Self arrow
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(-self.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.stroke();
}

// ============================================================
// Boot
// ============================================================
window.addEventListener('DOMContentLoaded', setupStartScreen);
