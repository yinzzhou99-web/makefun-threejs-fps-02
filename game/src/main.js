// Dustline Depot: a round-based tactical FPS. One fixed 60 Hz simulation owns the match:
// buy phase, live round, bomb plant and defuse, round and match scoring, a five-weapon
// economy shared by the player and nine bots. Bots plan over the world's waypoint graph,
// push or hold the two sites, plant, defuse and retake. Rendering reads the state the
// simulation leaves; nothing in the render loop decides anything.
//
// ?shot=start|play|plant|end with &seed=N poses a deterministic frame for a screenshot,
// renders it twice, freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld, SITES, SPAWNS, SPOTS } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { WEAPONS, ARMOR_PRICE, createWeaponView, spreadFor } from './weapon.js';
import { createBot, botDamage } from './bots.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';

const FIXED_STEP = 1 / 60;
const ROUND_TIME = 115;
const BUY_TIME = 12;
const BOMB_TIME = 40;
const END_TIME = 4.5;
const PLANT_TIME = 3.2;
const DEFUSE_TIME = 5;
const WIN_SCORE = 5;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = shot ? mulberry32(seed * 7919) : Math.random;

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.sky), 42, 120);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 220);
scene.add(camera);

const world = createWorld(scene);
const hud = createHud();
const audio = createAudio();
const player = createPlayer(world.colliders);
const input = createInput(renderer.domElement, onLockChange);

// ---------- actors ----------
const playerActor = {
  isPlayer: true,
  team: 'attack',
  name: 'You',
  pos: player.state.position,
  health: 100,
  armor: false,
  alive: true,
  kills: 0,
  deaths: 0,
  money: 800,
  crouching: false,
  eyePos(out) {
    return out.set(this.pos.x, this.pos.y + player.state.eye, this.pos.z);
  },
  chestPos(out) {
    return out.set(this.pos.x, this.pos.y + (player.state.crouching ? 0.95 : 1.25), this.pos.z);
  },
};
const bots = [];
for (let i = 0; i < 4; i++) bots.push(createBot(scene, world, 'attack', i, random));
for (let i = 0; i < 5; i++) bots.push(createBot(scene, world, 'defend', i, random));
const actors = [playerActor, ...bots];
const aliveCount = (team) => actors.filter((a) => a.team === team && a.alive).length;

// ---------- player kit ----------
const kit = {
  primary: null, // weapon id in slot 1
  sidearm: 'p9',
  current: 'p9',
  ammo: { p9: WEAPONS.p9.mag },
  reserve: { p9: WEAPONS.p9.reserve },
  grenades: 0,
  views: {},
};
function viewFor(id) {
  if (!kit.views[id]) kit.views[id] = createWeaponView(camera, WEAPONS[id]);
  return kit.views[id];
}
function equip(id) {
  if (kit.current && kit.views[kit.current]) kit.views[kit.current].setVisible(false);
  kit.current = id;
  viewFor(id).setVisible(true);
  reloadUntil = 0;
  bloom = 0;
}
function giveWeapon(actor, id) {
  if (actor.isPlayer) {
    const def = WEAPONS[id];
    if (def.slot === 1) kit.primary = id;
    kit.ammo[id] = def.mag;
    kit.reserve[id] = def.reserve;
  }
}

// ---------- match state ----------
const match = {
  phase: 'menu', // menu | buy | live | planted | end | over
  phaseT: 0,
  round: 0,
  attackScore: 0,
  defendScore: 0,
  bomb: { planted: false, site: null, pos: new THREE.Vector3(), t: 0, defused: false },
  lastNoise: null, // {pos, at, team}
  winner: null,
};
let now = 0;
let bloom = 0;
let nextShotAt = 0;
let reloadUntil = 0;
let scoped = false;
let hurtUntil = 0;
let buyOpen = false;
let scoreOpen = false;
let plantChannel = 0;
let lastBeepSecond = -1;
let started = false;

const raycaster = new THREE.Raycaster();
raycaster.far = 160;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

// ---------- tracers & impacts ----------
const tracerPool = [];
function tracer(from, to, color) {
  let item = tracerPool.find((t) => t.until <= now);
  if (!item) {
    if (tracerPool.length > 28) return;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.012, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0.85 }),
    );
    scene.add(mesh);
    item = { mesh, until: 0 };
    tracerPool.push(item);
  }
  const mid = tmpV.addVectors(from, to).multiplyScalar(0.5);
  item.mesh.position.copy(mid);
  item.mesh.lookAt(to);
  item.mesh.scale.set(1, 1, from.distanceTo(to));
  item.mesh.material.color.set(color);
  item.mesh.visible = true;
  item.until = now + 0.055;
}

// ---------- shooting ----------
// One hitscan resolution for every shooter: the wall distance comes from the raycaster,
// actor hits from sphere tests (head, chest, legs), so a bot's shot obeys the same cover
// as the player's. Returns what was hit.
function resolveShot(shooter, origin, dir, def) {
  raycaster.set(origin, dir);
  const wallHits = raycaster.intersectObjects(world.shootables, false);
  let wallDist = wallHits.length > 0 ? wallHits[0].distance : 160;
  let best = null;
  for (const actor of actors) {
    if (actor === shooter || !actor.alive || actor.team === shooter.team) continue;
    const parts = [
      { c: tmpV.set(actor.pos.x, actor.pos.y + 1.56, actor.pos.z), r: 0.19, part: 'head' },
      { c: tmpV2.set(actor.pos.x, actor.pos.y + 1.05, actor.pos.z), r: 0.44, part: 'body' },
    ];
    for (const p of parts) {
      const ox = p.c.x - origin.x, oy = p.c.y - origin.y, oz = p.c.z - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0 || t > wallDist) continue;
      const cx = origin.x + dir.x * t - p.c.x;
      const cy = origin.y + dir.y * t - p.c.y;
      const cz = origin.z + dir.z * t - p.c.z;
      if (cx * cx + cy * cy + cz * cz <= p.r * p.r && (best === null || t < best.dist)) {
        best = { actor, part: p.part, dist: t };
      }
    }
  }
  const end = new THREE.Vector3().copy(dir).multiplyScalar(best ? best.dist : wallDist).add(origin);
  const muzzle = tmpV2.set(origin.x, origin.y - 0.12, origin.z);
  tracer(muzzle, end, shooter.team === 'attack' ? PALETTE.amber : PALETTE.teal);
  match.lastNoise = { pos: origin.clone(), at: now, team: shooter.team };
  if (best === null) return { hit: null };
  const dmg = botDamage(def, best.dist, best.part, best.actor.armor);
  damage(best.actor, dmg, shooter, best.part === 'head');
  return { hit: best.actor, part: best.part };
}

function damage(victim, dmg, attacker, head) {
  if (!victim.alive || match.phase === 'end' || match.phase === 'over') return;
  victim.health -= dmg;
  if (victim.isPlayer) {
    hurtUntil = now + 220;
    audio.hurt();
  }
  if (attacker.isPlayer) {
    hud.hit(performance.now(), head);
    audio.hit(head);
  }
  if (victim.health <= 0) kill(victim, attacker, head);
}

function kill(victim, attacker, head) {
  victim.alive = false;
  victim.health = 0;
  victim.deaths += 1;
  if (attacker && attacker !== victim) {
    attacker.kills += 1;
    attacker.money += 300;
  }
  if (victim.isPlayer) {
    playerActor.alive = false;
  } else {
    victim.kill(now);
  }
  const aCls = attacker ? (attacker.team === 'attack' ? 'a' : 'd') : 'a';
  const vCls = victim.team === 'attack' ? 'a' : 'd';
  hud.killfeed(
    `<span class="${aCls}">${attacker ? attacker.name : '—'}</span> ▸ ${head ? '⌖ ' : ''}<span class="${vCls}">${victim.name}</span>`,
  );
  checkRoundEnd();
}

// ---------- grenades ----------
const grenades = [];
const grenadeMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 12, 10),
  new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.5, metalness: 0.3 }),
);
grenadeMesh.castShadow = true;
function throwGrenade() {
  if (kit.grenades <= 0) return;
  kit.grenades -= 1;
  const mesh = grenadeMesh.clone();
  scene.add(mesh);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const vel = dir.multiplyScalar(15.5);
  vel.y += 3.2;
  grenades.push({ mesh, pos: camera.position.clone(), vel, fuse: now + 1.55 });
  audio.shot('p9', 0);
}
function explode(g) {
  scene.remove(g.mesh);
  audio.explosion();
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1.4, 14, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0.95 }));
  flash.position.copy(g.pos);
  scene.add(flash);
  tracerPool.push({ mesh: flash, until: now + 0.12 });
  for (const actor of actors) {
    if (!actor.alive) continue;
    const d = Math.hypot(actor.pos.x - g.pos.x, actor.pos.z - g.pos.z);
    if (d > 6.5) continue;
    if (!world.lineOfSight({ x: g.pos.x, z: g.pos.z }, { x: actor.pos.x, z: actor.pos.z }, 0.6)) continue;
    const dmg = Math.round(WEAPONS.frag.damage * (1 - d / 7.5));
    damage(actor, dmg, playerActor, false);
  }
}
function stepGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.vel.y -= 18 * dt;
    g.pos.addScaledVector(g.vel, dt);
    if (g.pos.y < 0.1) {
      g.pos.y = 0.1;
      g.vel.y = Math.abs(g.vel.y) * 0.35;
      g.vel.x *= 0.7;
      g.vel.z *= 0.7;
    }
    g.mesh.position.copy(g.pos);
    if (now >= g.fuse) {
      explode(g);
      grenades.splice(i, 1);
    }
  }
}

// ---------- economy & plans ----------
function botLoadout(bot) {
  // A simple buy policy shared by both teams: rifle when rich, SMG when not, armour with
  // what is left; pistols on the first round and after a broke round.
  let want = 'p9';
  if (bot.money >= 2700) want = 'ar57';
  else if (bot.money >= 1200) want = 'raptor';
  if (want !== 'p9') bot.money -= WEAPONS[want].price;
  let armor = bot.armor;
  if (!armor && bot.money >= ARMOR_PRICE) {
    armor = true;
    bot.money -= ARMOR_PRICE;
  }
  return { weapon: want, armor };
}

const A_HOLDS = [SPOTS.aHold1, SPOTS.aHold2, SPOTS.aSiteWest];
const B_HOLDS = [SPOTS.bHold1, SPOTS.bHold2, SPOTS.bSiteWest];
function assignPlans() {
  const atk = bots.filter((b) => b.team === 'attack');
  const def = bots.filter((b) => b.team === 'defend');
  const sitePick = random() < 0.5 ? 'A' : 'B';
  atk.forEach((bot, i) => {
    if (i < 2) bot.plan = { kind: 'push', site: sitePick, spot: sitePick === 'A' ? SPOTS.aSiteWest : SPOTS.bSiteWest };
    else if (i === 2) bot.plan = { kind: 'push', site: sitePick === 'A' ? 'B' : 'A', spot: sitePick === 'A' ? SPOTS.bSiteWest : SPOTS.aSiteWest };
    else bot.plan = { kind: 'lurk', site: 'mid', spot: SPOTS.midEast };
  });
  def.forEach((bot, i) => {
    if (i < 2) bot.plan = { kind: 'hold', site: 'A', spot: A_HOLDS[i] };
    else if (i < 4) bot.plan = { kind: 'hold', site: 'B', spot: B_HOLDS[i - 2] };
    else bot.plan = { kind: 'hold', site: 'mid', spot: SPOTS.midHold };
  });
}
function rotateDefenders(site) {
  for (const bot of bots) {
    if (bot.team !== 'defend' || !bot.alive || bot.seen) continue;
    if (bot.plan && bot.plan.site !== site && bot.plan.site !== 'mid') continue;
    bot.plan = { kind: 'retake', site, spot: site === 'A' ? SPOTS.aSiteWest : SPOTS.bSiteWest };
  }
}

// ---------- round flow ----------
function startRound() {
  match.round += 1;
  match.phase = 'buy';
  match.phaseT = BUY_TIME;
  match.bomb = { planted: false, site: null, pos: new THREE.Vector3(), t: 0, defused: false };
  plantChannel = 0;
  lastBeepSecond = -1;
  // Player respawn.
  const pSpawn = SPAWNS.attack[4];
  player.state.position.set(pSpawn[0], 0, pSpawn[1]);
  player.state.velocity.set(0, 0, 0);
  player.state.yaw = -Math.PI / 2;
  player.state.pitch = 0;
  playerActor.health = 100;
  playerActor.alive = true;
  if (playerActor.deadLastRound) {
    kit.primary = null;
    kit.ammo = { p9: WEAPONS.p9.mag };
    kit.reserve = { p9: WEAPONS.p9.reserve };
    playerActor.armor = false;
    equip('p9');
  }
  playerActor.deadLastRound = false;
  // Bots respawn with their buy policy.
  bots.forEach((bot, i) => {
    const spawn = SPAWNS[bot.team][i % SPAWNS[bot.team].length];
    const load = bot.deadLastRound || match.round === 1 ? botLoadout(bot) : { weapon: bot.weaponId, armor: bot.armor };
    if (bot.deadLastRound) bot.money = Math.max(bot.money, 0);
    bot.reset(spawn, load.weapon, load.armor);
    bot.deadLastRound = false;
  });
  assignPlans();
  buyOpen = true;
  refreshBuyMenu();
  hud.banner(`ROUND ${match.round}`, 'Buy your kit — B for the menu', performance.now(), 2200);
}

function endRound(winnerTeam, reason) {
  if (match.phase === 'end' || match.phase === 'over') return;
  match.phase = 'end';
  match.phaseT = END_TIME;
  match.winner = winnerTeam;
  if (winnerTeam === 'attack') match.attackScore += 1;
  else match.defendScore += 1;
  const winPay = reason === 'bomb' ? 2900 : 2700;
  for (const actor of actors) {
    if (actor.team === winnerTeam) actor.money += winPay;
    else actor.money += 1900;
    if (!actor.alive) actor.deadLastRound = true;
  }
  if (match.bomb.planted && !match.bomb.defused && winnerTeam === 'defend') {
    // Defenders won on time or elimination with the bomb down: it never goes off.
    match.bomb.planted = false;
  }
  const mine = winnerTeam === 'attack';
  hud.banner(mine ? 'ROUND WON' : 'ROUND LOST', reason, performance.now(), 3400);
  audio.sting(mine);
  buyOpen = false;
  if (match.attackScore >= WIN_SCORE || match.defendScore >= WIN_SCORE) {
    match.phase = 'over';
    setTimeout(() => showMatchEnd(), 1200);
  }
}
function checkRoundEnd() {
  if (match.phase !== 'live' && match.phase !== 'planted') return;
  if (aliveCount('defend') === 0) return endRound('attack', 'Defenders eliminated');
  if (aliveCount('attack') === 0) {
    if (match.bomb.planted) return; // the bomb can still win it
    return endRound('defend', 'Attackers eliminated');
  }
}
function showMatchEnd() {
  const won = match.attackScore > match.defendScore;
  document.getElementById('overlay-title').textContent = won ? 'Match won' : 'Match lost';
  document.getElementById('overlay-copy').textContent = `Final score ${match.attackScore} – ${match.defendScore} after ${match.round} rounds. Your line: ${playerActor.kills} kills, ${playerActor.deaths} deaths.`;
  document.getElementById('play').textContent = 'Play again';
  document.getElementById('overlay').hidden = false;
  document.exitPointerLock?.();
}

// ---------- buying ----------
const BUY_ITEMS = [
  { key: '1', id: 'raptor', name: 'Raptor-9 SMG', price: 1200, desc: 'Fast, forgiving, short range' },
  { key: '2', id: 'ar57', name: 'AR-57 Rifle', price: 2700, desc: 'The all-round rifle' },
  { key: '3', id: 'longshot', name: 'Longshot DMR', price: 4200, desc: 'One-tap lanes, scoped' },
  { key: '4', id: 'armor', name: 'Kevlar Vest', price: ARMOR_PRICE, desc: 'Cuts bullet damage by 45%' },
  { key: '5', id: 'frag', name: 'Frag Grenade', price: 300, desc: 'Slot 3, up to two carried' },
];
function refreshBuyMenu() {
  hud.setBuyMenu(
    BUY_ITEMS.map((item) => ({
      ...item,
      owned:
        (item.id === 'armor' && playerActor.armor) ||
        (item.id === 'frag' && kit.grenades >= 2) ||
        (item.id !== 'armor' && item.id !== 'frag' && kit.primary === item.id),
    })),
    playerActor.money,
    buyItem,
  );
}
function buyItem(id) {
  const item = BUY_ITEMS.find((b) => b.id === id);
  if (!item || playerActor.money < item.price || match.phase !== 'buy') return;
  if (id === 'armor') {
    if (playerActor.armor) return;
    playerActor.armor = true;
  } else if (id === 'frag') {
    if (kit.grenades >= 2) return;
    kit.grenades += 1;
  } else {
    if (kit.primary === id) return;
    giveWeapon(playerActor, id);
    equip(id);
  }
  playerActor.money -= item.price;
  audio.buy();
  refreshBuyMenu();
}

// ---------- bot context ----------
const botCtx = {
  enemiesOf(bot) {
    return actors.filter((a) => a.team !== bot.team);
  },
  playerActor() {
    return playerActor;
  },
  shoot(bot, eye, dir, def) {
    audio.shot(def.id, bot.pos.distanceTo(player.state.position));
    resolveShot(bot, eye, dir, def);
  },
};

// ---------- per-step simulation ----------
function stepMatch(dt) {
  match.phaseT -= dt;
  if (match.phase === 'buy') {
    if (match.phaseT <= 0) {
      match.phase = 'live';
      match.phaseT = ROUND_TIME;
      buyOpen = false;
      hud.banner('ROUND LIVE', 'Plant at A or B — hold E in the site circle', performance.now(), 1800);
    }
    return;
  }
  if (match.phase === 'end' || match.phase === 'over') {
    if (match.phaseT <= 0 && match.phase === 'end') startRound();
    return;
  }
  if (match.phase === 'live' && match.phaseT <= 0) {
    endRound('defend', 'Time expired — no plant');
    return;
  }
  if (match.phase === 'planted') {
    match.bomb.t -= dt;
    const whole = Math.ceil(match.bomb.t);
    if (whole !== lastBeepSecond) {
      lastBeepSecond = whole;
      audio.plantBeep(match.bomb.t <= 0.2);
    }
    if (match.bomb.t <= 0) {
      audio.explosion();
      endRound('attack', 'Target bombed');
      return;
    }
    // A defender at the bomb with no attacker watching defuses.
    for (const bot of bots) {
      if (bot.team !== 'defend' || !bot.alive) continue;
      const near = Math.hypot(bot.pos.x - match.bomb.pos.x, bot.pos.z - match.bomb.pos.z) < 1.6;
      if (!near) continue;
      if (!bot.channel) bot.channel = { kind: 'defuse', t: 0, need: DEFUSE_TIME };
      if (bot.channel.t >= DEFUSE_TIME) {
        match.bomb.defused = true;
        match.bomb.planted = false;
        bot.channel = null;
        endRound('defend', 'Bomb defused');
        return;
      }
    }
  }
}

function stepPlayer(dt) {
  const canMove = (match.phase === 'live' || match.phase === 'planted') && playerActor.alive;
  const look = input.takeLook();
  const sens = scoped ? 0.0009 : 0.0022;
  if (input.state.locked || shot) player.look(look.x, look.y, sens);
  if (!canMove) return;
  player.step(dt, input.state.keys);
  playerActor.crouching = player.state.crouching;

  const def = WEAPONS[kit.current];
  // Reload.
  if (reloadUntil > 0 && now >= reloadUntil) {
    const take = Math.min(def.mag - kit.ammo[kit.current], kit.reserve[kit.current]);
    kit.ammo[kit.current] += take;
    kit.reserve[kit.current] -= take;
    reloadUntil = 0;
  }
  // Scope (Longshot only, right mouse).
  scoped = kit.current === 'longshot' && mouseDown.right && playerActor.alive;
  camera.fov += ((scoped ? 30 : 74) - camera.fov) * 0.4;
  camera.updateProjectionMatrix();

  bloom = Math.max(0, bloom - dt * 0.028);
  const wantFire = input.state.firing && (def.auto || mouseDown.leftEdge);
  mouseDown.leftEdge = false;
  if (wantFire && reloadUntil === 0 && now >= nextShotAt) {
    if (kit.current === 'frag') {
      throwGrenade();
      nextShotAt = now + 0.7;
      if (kit.grenades <= 0) equip(kit.primary ?? 'p9');
    } else if (kit.ammo[kit.current] > 0) {
      kit.ammo[kit.current] -= 1;
      nextShotAt = now + 60 / def.rpm;
      bloom = Math.min(0.055, bloom + def.bloom);
      const speed = player.groundSpeed();
      const spread = spreadFor(def, {
        moving: speed > 0.6,
        crouching: player.state.crouching,
        airborne: !player.state.onGround,
        scoped,
      }) + bloom;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      dir.x += (random() - 0.5) * 2 * spread;
      dir.y += (random() - 0.5) * 2 * spread;
      dir.z += (random() - 0.5) * 2 * spread;
      dir.normalize();
      const origin = camera.position.clone();
      audio.shot(def.id, 0);
      viewFor(kit.current).poke(now * 1000);
      player.recoil(def.kick * (1 + bloom * 9), (random() - 0.5) * def.kick * 0.4);
      resolveShot(playerActor, origin, dir, def);
      if (kit.ammo[kit.current] === 0 && kit.reserve[kit.current] > 0) startReload();
    } else {
      audio.dryFire();
      nextShotAt = now + 0.3;
      if (kit.reserve[kit.current] > 0) startReload();
    }
  }
  // Planting: hold E inside a site while the bomb is not down.
  const inSite = Object.values(SITES).find((s) => Math.hypot(player.state.position.x - s.x, player.state.position.z - s.z) <= s.r);
  if (match.phase === 'live' && inSite && input.state.keys.has('KeyE') && playerActor.alive) {
    plantChannel += dt;
    if (plantChannel >= PLANT_TIME) {
      match.bomb.planted = true;
      match.bomb.site = inSite === SITES.A ? 'A' : 'B';
      match.bomb.pos.copy(player.state.position);
      match.bomb.t = BOMB_TIME;
      match.phase = 'planted';
      plantChannel = 0;
      playerActor.money += 300;
      audio.plantBeep(true);
      hud.banner('BOMB PLANTED', `Site ${match.bomb.site} — defend it for ${BOMB_TIME} seconds`, performance.now(), 2200);
      rotateDefenders(match.bomb.site);
    }
  } else {
    plantChannel = Math.max(0, plantChannel - dt * 2);
  }
}
function startReload() {
  const def = WEAPONS[kit.current];
  if (kit.current === 'frag' || reloadUntil > 0) return;
  if (kit.ammo[kit.current] >= def.mag || kit.reserve[kit.current] <= 0) return;
  reloadUntil = now + def.reloadMs / 1000;
  audio.reload();
}

// ---------- input extras ----------
const mouseDown = { leftEdge: false, right: false };
window.addEventListener('mousedown', (e) => {
  if (e.button === 0) mouseDown.leftEdge = true;
  if (e.button === 2) mouseDown.right = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) mouseDown.right = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyB' && match.phase === 'buy') {
    buyOpen = !buyOpen;
    if (buyOpen) refreshBuyMenu();
  }
  if (e.code === 'Tab') {
    e.preventDefault();
    scoreOpen = true;
    refreshScoreboard();
  }
  if (buyOpen && match.phase === 'buy') {
    const item = BUY_ITEMS.find((b) => b.key === e.key);
    if (item) buyItem(item.id);
  } else {
    if (e.code === 'Digit1' && kit.primary) equip(kit.primary);
    if (e.code === 'Digit2') equip('p9');
    if (e.code === 'Digit3' && kit.grenades > 0) equip('frag');
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') scoreOpen = false;
});
function refreshScoreboard() {
  const rows = actors.map((a) => ({ name: a.name, team: a.team, alive: a.alive, kills: a.kills, deaths: a.deaths, money: a.isPlayer ? playerActor.money : a.money }));
  hud.scoreboard(rows, match.attackScore, match.defendScore);
}
function onLockChange(locked) {
  if (!locked && started && match.phase !== 'over' && !shot) {
    document.getElementById('overlay-title').textContent = 'Paused';
    document.getElementById('overlay-copy').textContent = 'Pointer unlocked. Click to keep playing.';
    document.getElementById('play').textContent = 'Resume';
    document.getElementById('overlay').hidden = false;
  }
}
document.getElementById('play').addEventListener('click', () => {
  audio.unlock();
  document.getElementById('overlay').hidden = true;
  if (!started) {
    started = true;
    startRound();
  }
  if (match.phase === 'over') {
    match.attackScore = 0;
    match.defendScore = 0;
    match.round = 0;
    for (const a of actors) {
      a.money = 800;
      a.kills = 0;
      a.deaths = 0;
      a.deadLastRound = true;
    }
    playerActor.armor = false;
    startRound();
  }
  input.requestLock();
});

// ---------- HUD snapshot ----------
function clockText() {
  if (match.phase === 'buy') return `0:${String(Math.max(0, Math.ceil(match.phaseT))).padStart(2, '0')}`;
  if (match.phase === 'planted') return `0:${String(Math.max(0, Math.ceil(match.bomb.t))).padStart(2, '0')}`;
  const t = Math.max(0, Math.ceil(match.phaseT));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
let mapAt = 0;
function pushHud() {
  const def = WEAPONS[kit.current];
  hud.update(performance.now(), {
    health: playerActor.health,
    armor: playerActor.armor,
    alive: playerActor.alive,
    scoped,
    ammo: kit.ammo[kit.current] ?? 0,
    reserve: kit.reserve[kit.current] ?? 0,
    weaponId: kit.current,
    weaponName: def.name,
    grenades: kit.grenades,
    money: playerActor.money,
    clock: clockText(),
    clockUrgent: (match.phase === 'live' && match.phaseT < 15) || match.phase === 'planted',
    phaseLabel: match.phase === 'buy' ? `BUY — ROUND ${match.round}` : match.phase === 'planted' ? `SITE ${match.bomb.site}` : match.phase === 'live' ? `ROUND ${match.round}` : match.phase.toUpperCase(),
    attackScore: match.attackScore,
    defendScore: match.defendScore,
    bombPlanted: match.bomb.planted,
    hurt: performance.now() < hurtUntil,
    spreadPx: (spreadFor(def, { moving: player.groundSpeed() > 0.6, crouching: player.state.crouching, airborne: !player.state.onGround, scoped }) + bloom) * 620,
    plant: plantChannel > 0 ? { label: 'PLANTING', frac: plantChannel / PLANT_TIME } : defuseProgress(),
    buyOpen: buyOpen && match.phase === 'buy',
    scoreOpen,
  });
  if (performance.now() > mapAt) {
    mapAt = performance.now() + 150;
    hud.drawMap(world, actors, player.state.position, player.state.yaw);
  }
}
function defuseProgress() {
  for (const bot of bots) {
    if (bot.channel && bot.channel.kind === 'defuse') return { label: 'ENEMY DEFUSING', frac: bot.channel.t / DEFUSE_TIME };
  }
  return null;
}

// ---------- main loop ----------
let last = performance.now();
let acc = 0;
function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  let dt = (t - last) / 1000;
  last = t;
  dt = Math.min(dt, 0.1);
  acc += dt;
  while (acc >= FIXED_STEP) {
    acc -= FIXED_STEP;
    now += FIXED_STEP;
    if (started && !shot) {
      stepMatch(FIXED_STEP);
      if (match.phase === 'live' || match.phase === 'planted' || match.phase === 'end') {
        for (const bot of bots) bot.update(FIXED_STEP, now, botCtx);
      }
      stepPlayer(FIXED_STEP);
      stepGrenades(FIXED_STEP);
      // Defenders rotate to the first site where a teammate makes contact.
      if (match.phase === 'live') {
        for (const bot of bots) {
          if (bot.team === 'defend' && bot.seen && bot.plan && bot.plan.site !== 'mid') rotateDefenders(bot.plan.site);
        }
      }
    }
  }
  // Camera from the player state.
  const p = player.state;
  camera.position.set(p.position.x, p.position.y + p.eye, p.position.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch;
  if (!playerActor.alive) camera.rotation.z = 0.5;
  else camera.rotation.z = 0;
  for (const item of tracerPool) if (item.until <= now) item.mesh.visible = false;
  if (kit.views[kit.current]) kit.views[kit.current].update(now * 1000);
  pushHud();
  renderer.render(scene, camera);
}

// ---------- shot scenes (deterministic screenshots) ----------
function poseBot(bot, x, z, yaw, crouch) {
  bot.pos.set(x, 0, z);
  bot.yaw = yaw;
  bot.figure.group.position.copy(bot.pos);
  bot.figure.group.rotation.y = yaw;
  if (crouch) bot.figure.group.position.y = -0.35;
}
function setupShot(name) {
  started = true;
  document.getElementById('overlay').hidden = true;
  match.round = 3;
  match.attackScore = 2;
  match.defendScore = 1;
  const atk = bots.filter((b) => b.team === 'attack');
  const def = bots.filter((b) => b.team === 'defend');
  bots.forEach((bot, i) => {
    const spawn = SPAWNS[bot.team][i % SPAWNS[bot.team].length];
    bot.reset(spawn, bot.team === 'attack' ? 'ar57' : 'ar57', true);
  });
  equip('ar57');
  kit.ammo.ar57 = 30;
  kit.reserve.ar57 = 90;
  kit.primary = 'ar57';
  playerActor.armor = true;
  if (name === 'start') {
    match.phase = 'buy';
    match.phaseT = 9;
    buyOpen = true;
    refreshBuyMenu();
    player.state.position.set(-26.5, 0, 3.4);
    player.state.yaw = -Math.PI / 2 - 0.35;
    poseBot(atk[0], -25.2, -1.2, -Math.PI / 2);
    poseBot(atk[1], -24.6, 2.2, -Math.PI / 2 + 0.4);
    hud.banner('ROUND 3', 'Buy phase — first to 5', performance.now(), 60000);
  } else if (name === 'play') {
    match.phase = 'live';
    match.phaseT = 72;
    player.state.position.set(9.5, 0, -18.8);
    player.state.yaw = -Math.PI / 2 - 0.18;
    player.state.pitch = -0.02;
    playerActor.health = 72;
    kit.ammo.ar57 = 24;
    poseBot(def[0], 20, -12.6, Math.PI / 2 + 0.5);
    poseBot(def[1], 24.5, -9, Math.PI / 2 - 0.4);
    poseBot(atk[0], 15.5, -15.6, -Math.PI / 2);
    poseBot(atk[1], 16, -20.5, -Math.PI / 2 + 0.3);
    def[0].figure.gun.rotation.x = -0.06;
    tracer(new THREE.Vector3(20, 1.45, -12.6), new THREE.Vector3(10.4, 1.3, -18.2), PALETTE.teal);
    hud.hit(performance.now() + 60000, false);
    hud.killfeed('<span class="a">You</span> ▸ <span class="d">Marsh</span>');
    hud.killfeed('<span class="d">Rook</span> ▸ <span class="a">Kite</span>');
  } else if (name === 'plant') {
    match.phase = 'live';
    match.phaseT = 47;
    player.state.position.set(20.5, 0, 15.5);
    player.state.yaw = 1.05;
    player.state.pitch = -0.1;
    player.state.crouching = true;
    plantChannel = PLANT_TIME * 0.62;
    poseBot(atk[0], 14.8, 12.6, -2.4);
    poseBot(def[0], 13.5, 11.5, -2.2);
    hud.killfeed('<span class="a">Sable</span> ▸ <span class="d">Hollis</span>');
  } else {
    // end
    match.phase = 'end';
    match.attackScore = 4;
    match.defendScore = 2;
    match.bomb.planted = true;
    match.bomb.site = 'A';
    player.state.position.set(15.5, 0, -16.5);
    player.state.yaw = -Math.PI / 2 - 0.15;
    playerActor.kills = 7;
    playerActor.deaths = 3;
    atk[0].kills = 5;
    def[0].kills = 6;
    poseBot(atk[0], 18.5, -19.5, -Math.PI / 2);
    def[1].kill(0);
    poseBot(def[1], 20.5, -14.5, 0.6);
    def[1].figure.group.rotation.z = Math.PI / 2;
    def[1].figure.group.position.y = 0.18;
    hud.banner('ROUND WON', 'Target bombed — match point next round', performance.now(), 60000);
  }
  // Two renders, then freeze: the capture reads window.__shotReady.
  camera.position.set(player.state.position.x, player.state.eye + 0, player.state.position.z);
  camera.position.y = player.state.position.y + player.state.eye;
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.state.yaw;
  camera.rotation.x = player.state.pitch;
  pushHud();
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  window.__shotReady = true;
}

if (shot) {
  setupShot(shot);
} else {
  frame();
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
