// Weapons: five definitions, one firing model. Accuracy is a cone whose radius grows with
// bloom (shots fired in a burst), movement and air time, and shrinks back when the player
// stops and waits: stopping to aim pays, spraying on the move does not. Damage falls off
// with range and multiplies on the head. The same table drives the player's guns and the
// bots', so a bot's rifle is exactly as fair as the player's.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  p9: { id: 'p9', name: 'P9 Sidearm', slot: 2, price: 0, damage: 34, headMult: 3.0, rpm: 400, mag: 12, reserve: 48, reloadMs: 1500, spread: 0.011, bloom: 0.006, moveSpread: 0.03, range: 42, auto: false, kick: 0.011, pellets: 1 },
  raptor: { id: 'raptor', name: 'Raptor-9 SMG', slot: 1, price: 1200, damage: 26, headMult: 2.6, rpm: 780, mag: 32, reserve: 96, reloadMs: 2100, spread: 0.017, bloom: 0.0075, moveSpread: 0.026, range: 34, auto: true, kick: 0.008, pellets: 1 },
  ar57: { id: 'ar57', name: 'AR-57 Rifle', slot: 1, price: 2700, damage: 37, headMult: 3.4, rpm: 600, mag: 30, reserve: 90, reloadMs: 2400, spread: 0.009, bloom: 0.0085, moveSpread: 0.034, range: 60, auto: true, kick: 0.013, pellets: 1 },
  longshot: { id: 'longshot', name: 'Longshot DMR', slot: 1, price: 4200, damage: 96, headMult: 2.2, rpm: 52, mag: 5, reserve: 25, reloadMs: 2900, spread: 0.0015, bloom: 0.02, moveSpread: 0.09, range: 110, auto: false, kick: 0.05, pellets: 1, scoped: true },
  frag: { id: 'frag', name: 'Frag Grenade', slot: 3, price: 300, damage: 92, headMult: 1, rpm: 60, mag: 1, reserve: 0, reloadMs: 0, spread: 0, bloom: 0, moveSpread: 0, range: 7, auto: false, kick: 0, pellets: 0 },
};
export const ARMOR_PRICE = 650;

/** Spread radius (radians) for a shooter in this state, before bloom is added by the caller. */
export function spreadFor(def, { moving, crouching, airborne, scoped }) {
  let s = def.spread;
  if (moving) s += def.moveSpread;
  if (airborne) s += 0.05;
  if (crouching) s *= 0.72;
  if (scoped) s *= 0.25;
  return s;
}

/** Damage at a range, with the head multiplier applied by the caller for head hits. */
export function damageAt(def, metres) {
  if (metres <= def.range * 0.45) return def.damage;
  const t = Math.min(1, (metres - def.range * 0.45) / (def.range * 0.55));
  return Math.max(1, Math.round(def.damage * (1 - 0.55 * t)));
}

/** A simple box-built view model per weapon family, hung off the camera. */
export function createWeaponView(camera, def) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.5, metalness: 0.55 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.surface), roughness: 0.42, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.amber), roughness: 0.5, metalness: 0.3 });
  function part(w, h, d, x, y, z, mat = body) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }
  if (def.id === 'p9') {
    part(0.055, 0.09, 0.24, 0, 0, -0.05);
    part(0.04, 0.1, 0.05, 0, -0.09, 0.03, dark);
  } else if (def.id === 'raptor') {
    part(0.06, 0.1, 0.44, 0, 0, -0.1);
    part(0.045, 0.16, 0.06, 0, -0.12, -0.02, dark);
    part(0.03, 0.03, 0.18, 0, 0.02, -0.4, dark);
  } else if (def.id === 'longshot') {
    part(0.055, 0.09, 0.72, 0, 0, -0.2);
    part(0.05, 0.06, 0.2, 0, 0.09, -0.18, dark); // scope
    part(0.04, 0.13, 0.05, 0, -0.1, 0.02, dark);
    part(0.025, 0.025, 0.3, 0, 0.01, -0.62, dark);
  } else if (def.id === 'frag') {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), accent);
    ball.position.set(0, -0.02, -0.12);
    group.add(ball);
  } else {
    part(0.06, 0.11, 0.56, 0, 0, -0.14);
    part(0.045, 0.17, 0.06, 0, -0.13, -0.05, dark);
    part(0.035, 0.05, 0.1, 0, 0.09, -0.2, dark); // carry sight
    part(0.028, 0.028, 0.22, 0, 0.015, -0.5, dark);
    part(0.05, 0.07, 0.16, 0, -0.02, 0.16, dark); // stock
  }
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  flash.position.set(0, 0.01, def.id === 'longshot' ? -0.8 : -0.52);
  group.add(flash);
  group.position.set(0.21, -0.19, -0.42);
  camera.add(group);
  return {
    group,
    flash,
    setVisible(v) {
      group.visible = v;
    },
    /** Muzzle flash + a small view kick, decaying in update(). */
    poke(now) {
      flash.material.opacity = 0.9;
      flash.rotation.z = (now * 0.37) % Math.PI;
      group.position.z = -0.38;
    },
    update() {
      flash.material.opacity = Math.max(0, flash.material.opacity - 0.09);
      group.position.z += (-0.42 - group.position.z) * 0.35;
    },
  };
}
