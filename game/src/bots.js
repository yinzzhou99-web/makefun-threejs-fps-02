// Bots: the other nine players. Each bot is a small state machine over the world's waypoint
// graph: it follows a plan (attackers push a site behind the bomb carrier, defenders hold
// spots and retake after a plant), sees through the same line-of-sight test the map uses,
// hears gunfire, and shoots with the shared weapon table plus a human aim error that
// shrinks the longer it tracks a target. Bots stop to fire, strafe between bursts, channel
// the plant and the defuse, and drop where they die until the round resets.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { WEAPONS, damageAt } from './weapon.js';

const EYE = 1.55;
const CHEST = 1.25;
const RADIUS = 0.36;
const WALK = 4.7;
const COMBAT_WALK = 2.6;

const NAMES = {
  attack: ['Vex', 'Oro', 'Sable', 'Kite'],
  defend: ['Bastion', 'Hollis', 'Marsh', 'Quill', 'Rook'],
};

function buildFigure(team) {
  const group = new THREE.Group();
  const uniform = new THREE.MeshStandardMaterial({ color: new THREE.Color(team === 'attack' ? PALETTE.rust : PALETTE.steel), roughness: 0.8, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.clay), roughness: 0.7 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(team === 'attack' ? PALETTE.amber : PALETTE.teal), roughness: 0.5 });
  function part(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  }
  const legL = part(new THREE.BoxGeometry(0.16, 0.78, 0.2), dark, -0.11, 0.39, 0);
  const legR = part(new THREE.BoxGeometry(0.16, 0.78, 0.2), dark, 0.11, 0.39, 0);
  const torso = part(new THREE.BoxGeometry(0.46, 0.62, 0.26), uniform, 0, 1.09, 0);
  part(new THREE.BoxGeometry(0.47, 0.1, 0.27), accent, 0, 1.3, 0); // team stripe
  const head = part(new THREE.BoxGeometry(0.24, 0.26, 0.24), skin, 0, 1.56, 0);
  part(new THREE.BoxGeometry(0.26, 0.09, 0.26), dark, 0, 1.72, 0); // cap
  const gun = part(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark, 0.2, 1.18, -0.3);
  return { group, legL, legR, torso, head, gun };
}

export function createBot(scene, world, team, index, random) {
  const figure = buildFigure(team);
  scene.add(figure.group);
  const bot = {
    isPlayer: false,
    team,
    name: NAMES[team][index % NAMES[team].length],
    figure,
    pos: new THREE.Vector3(),
    yaw: 0,
    health: 100,
    armor: false,
    alive: true,
    weaponId: 'p9',
    ammo: 12,
    reserve: 48,
    money: 800,
    kills: 0,
    deaths: 0,
    path: [],
    pathI: 0,
    plan: null, // {kind:'push'|'hold'|'cover'|'retake'|'plant'|'defuse', spot:{x,z}, site}
    seen: null, // {actor, at, pos}
    lastHurtBy: null,
    thinkAt: 0,
    burstLeft: 0,
    nextShotAt: 0,
    strafeDir: 1,
    strafeAt: 0,
    channel: null, // {kind, t, need}
    walkPhase: random() * 6,
    deadAt: 0,
  };
  figure.torso.userData.bot = bot;
  figure.torso.userData.part = 'body';
  figure.head.userData.bot = bot;
  figure.head.userData.part = 'head';
  figure.legL.userData.bot = bot;
  figure.legL.userData.part = 'body';
  figure.legR.userData.bot = bot;
  figure.legR.userData.part = 'body';

  bot.hitMeshes = [figure.torso, figure.head, figure.legL, figure.legR];

  bot.reset = (spawn, weaponId, armor) => {
    bot.pos.set(spawn[0], 0, spawn[1]);
    bot.yaw = team === 'attack' ? -Math.PI / 2 : Math.PI / 2;
    bot.health = 100;
    bot.armor = armor;
    bot.alive = true;
    bot.weaponId = weaponId;
    const def = WEAPONS[weaponId];
    bot.ammo = def.mag;
    bot.reserve = def.reserve;
    bot.path = [];
    bot.pathI = 0;
    bot.seen = null;
    bot.channel = null;
    bot.burstLeft = 0;
    figure.group.visible = true;
    figure.group.rotation.set(0, 0, 0);
    figure.group.position.copy(bot.pos);
    figure.group.rotation.y = bot.yaw;
  };

  bot.eyePos = (out) => out.set(bot.pos.x, EYE, bot.pos.z);
  bot.chestPos = (out) => out.set(bot.pos.x, CHEST, bot.pos.z);

  function moveToward(target, dt, speed) {
    const dx = target.x - bot.pos.x;
    const dz = target.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.15) return true;
    const stepLen = Math.min(dist, speed * dt);
    bot.pos.x += (dx / dist) * stepLen;
    bot.pos.z += (dz / dist) * stepLen;
    bot.yaw = Math.atan2(-(dx / dist), -(dz / dist));
    bot.walkPhase += dt * speed * 2.4;
    // Push out of solids (2D, body radius).
    for (const s of world.solids) {
      if (s.h < 0.9) continue;
      const nx = Math.max(s.x0, Math.min(bot.pos.x, s.x1));
      const nz = Math.max(s.z0, Math.min(bot.pos.z, s.z1));
      const px = bot.pos.x - nx, pz = bot.pos.z - nz;
      const d2 = px * px + pz * pz;
      if (d2 < RADIUS * RADIUS) {
        if (d2 < 1e-6) {
          bot.pos.x = nx + RADIUS;
        } else {
          const d = Math.sqrt(d2);
          bot.pos.x = nx + (px / d) * RADIUS;
          bot.pos.z = nz + (pz / d) * RADIUS;
        }
      }
    }
    return dist <= Math.max(0.3, speed * dt);
  }

  const eye = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const aim = new THREE.Vector3();

  /** The nearest visible enemy, or null. Vision is a cone, widened when alerted. */
  function scan(enemies, now) {
    bot.eyePos(eye);
    let best = null;
    let bestD = Infinity;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      enemy.chestPos(chest);
      const d = eye.distanceTo(chest);
      if (d > 58 || d >= bestD) continue;
      const alerted = bot.seen !== null && now - bot.seen.at < 2.5;
      if (!alerted && d > 4) {
        const fx = -Math.sin(bot.yaw), fz = -Math.cos(bot.yaw);
        const dot = ((chest.x - eye.x) * fx + (chest.z - eye.z) * fz) / (d || 1);
        if (dot < 0.25) continue; // outside the ~75 degree half-cone
      }
      if (!world.lineOfSight({ x: eye.x, z: eye.z }, { x: chest.x, z: chest.z }, 1.5)) continue;
      best = enemy;
      bestD = d;
    }
    return best;
  }

  bot.update = (dt, now, ctx) => {
    if (!bot.alive) return;
    const enemies = ctx.enemiesOf(bot);
    // Perception runs on a think tick, movement and fire every step.
    if (now >= bot.thinkAt) {
      bot.thinkAt = now + 0.12;
      const found = scan(enemies, now);
      if (found) bot.seen = { actor: found, at: now, pos: found.pos.clone() };
      else if (bot.seen && now - bot.seen.at > 3) bot.seen = null;
      if (bot.plan) bot.path = world.findPath(bot.pos, bot.plan.spot);
      bot.pathI = 0;
    }
    const target = bot.seen && bot.seen.actor.alive ? bot.seen.actor : null;
    const visibleNow = target !== null && now - bot.seen.at < 0.35;

    if (bot.channel) {
      // Planting or defusing: stand still, keep channelling; main reads bot.channel.
      bot.channel.t += dt;
      figure.group.position.copy(bot.pos);
      figure.group.rotation.y = bot.yaw;
      return;
    }

    if (visibleNow) {
      // Engage: face the target, stop to shoot in bursts, sidestep between them.
      target.chestPos(aim);
      bot.yaw = Math.atan2(-(aim.x - bot.pos.x), -(aim.z - bot.pos.z));
      if (now >= bot.strafeAt) {
        bot.strafeAt = now + 0.7 + random() * 0.5;
        bot.strafeDir = random() < 0.5 ? -1 : 1;
      }
      if (bot.burstLeft <= 0 && now >= bot.nextShotAt) {
        const side = { x: bot.pos.x + Math.cos(bot.yaw) * bot.strafeDir * 1.4, z: bot.pos.z - Math.sin(bot.yaw) * bot.strafeDir * 1.4 };
        moveToward(side, dt, COMBAT_WALK);
      }
      if (now >= bot.nextShotAt) {
        const def = WEAPONS[bot.weaponId];
        if (bot.ammo <= 0) {
          if (bot.reserve > 0) {
            const take = Math.min(def.mag, bot.reserve);
            bot.ammo = take;
            bot.reserve -= take;
            bot.nextShotAt = now + def.reloadMs / 1000;
          } else {
            bot.weaponId = 'p9';
            bot.ammo = WEAPONS.p9.mag;
            bot.reserve = WEAPONS.p9.reserve;
          }
        } else {
          if (bot.burstLeft <= 0) bot.burstLeft = 3 + Math.floor(random() * 3);
          bot.burstLeft -= 1;
          const trackTime = Math.min(1, (now - bot.seen.at + 0.35) / 1.1);
          const err = 0.055 - 0.038 * trackTime; // aim settles as the bot tracks
          bot.eyePos(eye);
          aim.y = target === ctx.playerActor() && target.crouching ? 0.95 : CHEST + (random() < 0.22 ? 0.33 : 0);
          const dir = aim.sub(eye).normalize();
          dir.x += (random() - 0.5) * 2 * err;
          dir.y += (random() - 0.5) * 2 * err;
          dir.z += (random() - 0.5) * 2 * err;
          dir.normalize();
          ctx.shoot(bot, eye.clone(), dir, def);
          bot.ammo -= 1;
          const gap = 60 / def.rpm;
          bot.nextShotAt = now + (bot.burstLeft > 0 ? gap : gap * (2.6 + random() * 2));
        }
      }
    } else if (bot.path.length > 0) {
      const node = bot.path[Math.min(bot.pathI, bot.path.length - 1)];
      if (moveToward(node, dt, WALK)) {
        bot.pathI += 1;
        if (bot.pathI >= bot.path.length) bot.path = [];
      }
    }

    // Figure follows state; legs swing while walking, the gun tracks the view.
    figure.group.position.copy(bot.pos);
    figure.group.rotation.y = bot.yaw;
    const swing = Math.sin(bot.walkPhase) * 0.4;
    figure.legL.rotation.x = swing;
    figure.legR.rotation.x = -swing;
    figure.gun.rotation.x = visibleNow ? -0.06 : 0.25;
  };

  bot.kill = (now) => {
    bot.alive = false;
    bot.deadAt = now;
    bot.channel = null;
    figure.group.rotation.z = Math.PI / 2; // down
    figure.group.position.y = 0.18;
  };

  return bot;
}

/** Bot-vs-bot and bot-vs-player damage share the player's table (weapon.js). */
export function botDamage(def, metres, part, armor) {
  let dmg = damageAt(def, metres);
  if (part === 'head') dmg = Math.round(dmg * def.headMult);
  if (armor) dmg = Math.round(dmg * 0.55);
  return dmg;
}
