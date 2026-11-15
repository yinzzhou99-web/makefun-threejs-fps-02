// The map: "Dustline Depot", an original sun-baked logistics yard. Two bomb sites (A north,
// B south) on the east side, attacker spawn west, defender spawn centre-east, a mid corridor
// with double doors, and container lanes north and south. Everything is boxes: each box is a
// player collider, a bullet stopper and a sight blocker, and the waypoint graph the bots walk
// is derived from the same solids, so the map and the AI can never disagree.
//
// Layout (metres, x east, z south): playfield x -32..32, z -24..24.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const SITES = {
  A: { x: 21, z: -14, r: 6 },
  B: { x: 21, z: 14, r: 6 },
};
export const SPAWNS = {
  attack: [[-28, -6], [-29, -2], [-28, 2], [-29, 6], [-27, 0]],
  defend: [[27, -4], [28, 0], [27, 4], [26, -8], [26, 8]],
};
// Named spots the bot plans use: lane ends, site holds, mid doors.
export const SPOTS = {
  tSpawn: { x: -27, z: 0 },
  midWest: { x: -10, z: 0 },
  midDoors: { x: 0, z: 0 },
  midEast: { x: 10, z: 0 },
  ctSpawn: { x: 26, z: 0 },
  aLinkWest: { x: -12, z: -17 },
  aSiteWest: { x: 12, z: -15 },
  aSite: { x: 21, z: -14 },
  aHold1: { x: 16, z: -19 },
  aHold2: { x: 24, z: -8.5 },
  bLinkWest: { x: -12, z: 17 },
  bSiteWest: { x: 12, z: 15 },
  bSite: { x: 21, z: 14 },
  bHold1: { x: 13.5, z: 18 },
  bHold2: { x: 23.5, z: 8.6 },
  midHold: { x: 6, z: -4 },
};

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'amber' || name === 'ink' ? 0.5 : 0.94,
      metalness: 0.04,
    });
  }
  materials.rustMetal = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.62, metalness: 0.35 });
  materials.steelMetal = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.55, metalness: 0.4 });

  const colliders = []; // THREE.Box3, for the player's 3D movement
  const solids = []; // {x0,x1,z0,z1,h} footprints, for sight lines and the waypoint graph
  const shootables = [];

  function box(w, h, d, x, y, z, material, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[material] ?? materials.clay);
    mesh.position.set(x, y, z);
    mesh.castShadow = opts.flat !== true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (opts.flat !== true) {
      colliders.push(new THREE.Box3(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)));
      solids.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, h: y + h / 2 });
      shootables.push(mesh);
    }
    return mesh;
  }
  const wall = (w, d, x, z, h = 4.4, material = 'clay') => box(w, h, d, x, h / 2, z, material);
  const crate = (x, z, s = 1.4, h = 1.4, material = 'clayDark') => box(s, h, s, x, h / 2, z, material);
  const container = (x, z, alongX, material) => (alongX ? box(6.1, 2.6, 2.44, x, 1.3, z, material) : box(2.44, 2.6, 6.1, x, 1.3, z, material));

  // Ground and perimeter.
  box(68, 0.4, 52, 0, -0.2, 0, 'sand', { flat: true });
  wall(68, 1, 0, -24.5, 5.2);
  wall(68, 1, 0, 24.5, 5.2);
  wall(1, 52, -32.5, 0, 5.2);
  wall(1, 52, 32.5, 0, 5.2);

  // Mid corridor walls (z = -3.4 and z = 3.4), one door gap each at x -2..2.
  for (const zc of [-3.4, 3.4]) {
    wall(30, 0.8, -17, zc);
    wall(30, 0.8, 17, zc, 4.4, 'clayDark');
  }
  // The double doors: steel slabs either side of a 1.2 m choke in each mid wall.
  for (const zc of [-3.4, 3.4]) {
    box(1.4, 3.1, 0.35, -1.3, 1.55, zc, 'steelMetal');
    box(1.4, 3.1, 0.35, 1.3, 1.55, zc, 'steelMetal');
  }

  // North and south lane walls: a divider at x = -6, and a long wall at z = -/+8.6 that
  // leaves a west entry from spawn and an east exit toward the sites.
  wall(0.8, 14, -6, -10.4);
  wall(0.8, 14, -6, 10.4);
  wall(26, 0.8, -6, -8.6, 4.4, 'clayDark');
  wall(26, 0.8, -6, 8.6, 4.4, 'clayDark');

  // Site A: container yard.
  container(21, -19.5, true, 'rustMetal');
  container(15.5, -12.5, false, 'steelMetal');
  container(26.5, -11, false, 'rustMetal');
  crate(19, -15.5);
  crate(23.5, -16.5, 1.4, 1.4, 'rustDark');
  crate(18, -10.5);
  box(6.1, 2.6, 2.44, 21, 3.9, -19.5, 'rustDark'); // stacked container, top level (visual + high cover)

  // Site B: warehouse apron.
  container(18, 18.5, true, 'steelMetal');
  container(26, 12.5, false, 'rustMetal');
  crate(21, 10.8);
  crate(15.5, 14.5, 1.4, 1.4, 'rustDark');
  box(8, 3.4, 5, 29.5, 1.7, 19, 'clayDark'); // warehouse block in the corner

  // Mid and lane cover.
  crate(-16, -1.6);
  crate(-16, 1.8, 1.4, 1.4, 'rustDark');
  crate(4, -6.5);
  crate(4, 6.5, 1.4, 1.4, 'rustDark');
  crate(-20, -16);
  crate(-20, 16, 1.4, 1.4, 'rustDark');
  crate(8, -16);
  crate(8, 16);
  crate(-2, -13, 1.4, 2.2, 'clayDark');
  crate(-2, 13, 1.4, 2.2, 'clayDark');
  container(-24, -8, false, 'steelMetal');
  container(-24, 8, false, 'rustMetal');
  box(3.2, 2.2, 1.2, 0, 1.1, -8.6, 'clay'); // mid-north divider block
  box(3.2, 2.2, 1.2, 0, 1.1, 8.6, 'clay');

  // Site floor markings: a flat ring and a letter plate per site, drawn on canvas textures.
  function siteMark(site, letter, color) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(site.r - 0.7, site.r, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.02, site.z);
    group.add(ring);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = '900 96px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 64, 70);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0.8 }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(site.x, 0.03, site.z);
    group.add(plate);
  }
  siteMark(SITES.A, 'A', PALETTE.amber);
  siteMark(SITES.B, 'B', PALETTE.teal);

  // Light: low warm sun from the south-west, cool sky fill; shadows span the yard.
  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.sky), new THREE.Color(PALETTE.sand), 1.05);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color(PALETTE.ink), 2.4);
  sun.position.set(-26, 30, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.camera.far = 110;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.steel), 0.5);
  fill.position.set(20, 16, -22);
  scene.add(fill);

  // The waypoint graph: fixed nodes on the lanes, edges where a straight walk clears every
  // solid by a body radius. Bots path over this; it is built once from the solids above.
  const nodes = [
    SPOTS.tSpawn, { x: -27, z: -13 }, { x: -27, z: 13 }, SPOTS.aLinkWest, SPOTS.bLinkWest,
    SPOTS.midWest, { x: -12, z: -13 }, { x: -12, z: 13 }, SPOTS.midDoors, SPOTS.midEast,
    { x: 6, z: -13 }, { x: 6, z: 13 }, SPOTS.aSiteWest, SPOTS.bSiteWest, SPOTS.ctSpawn,
    SPOTS.aSite, SPOTS.bSite, SPOTS.aHold1, SPOTS.aHold2, SPOTS.bHold1, SPOTS.bHold2, SPOTS.midHold,
    { x: 12, z: 0 }, { x: -2, z: -17 }, { x: -2, z: 17 }, { x: 27, z: -16 }, { x: 27, z: 16 },
  ];
  function segmentClear(ax, az, bx, bz, pad) {
    for (const s of solids) {
      if (s.h < 1.2) continue;
      // Segment vs expanded AABB (slab test).
      const x0 = s.x0 - pad, x1 = s.x1 + pad, z0 = s.z0 - pad, z1 = s.z1 + pad;
      const dx = bx - ax, dz = bz - az;
      let t0 = 0, t1 = 1;
      if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) continue; }
      else {
        let ta = (x0 - ax) / dx, tb = (x1 - ax) / dx;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) continue; }
      else {
        let ta = (z0 - az) / dz, tb = (z1 - az) / dz;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      return false;
    }
    return true;
  }
  const edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (segmentClear(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z, 0.45)) {
        edges[i].push(j);
        edges[j].push(i);
      }
    }
  }
  /** Shortest node path from a point to a point (BFS over nearest visible nodes). */
  function findPath(from, to) {
    const start = nearestNode(from);
    const goal = nearestNode(to);
    if (start === -1 || goal === -1) return [to];
    if (start === goal) return [to];
    const prev = new Array(nodes.length).fill(-1);
    const queue = [start];
    prev[start] = start;
    while (queue.length > 0) {
      const at = queue.shift();
      if (at === goal) break;
      for (const next of edges[at]) {
        if (prev[next] === -1) {
          prev[next] = at;
          queue.push(next);
        }
      }
    }
    if (prev[goal] === -1) return [to];
    const path = [];
    let at = goal;
    while (at !== start) {
      path.push(nodes[at]);
      at = prev[at];
    }
    path.reverse();
    path.push(to);
    return path;
  }
  function nearestNode(p) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = (nodes[i].x - p.x) ** 2 + (nodes[i].z - p.z) ** 2;
      if (d < bestD && segmentClear(p.x, p.z, nodes[i].x, nodes[i].z, 0.45)) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  /** True when a standing eye at `eye` sees point `p`: no solid above eye height crosses. */
  function lineOfSight(eye, p, height = 1.62) {
    for (const s of solids) {
      if (s.h < height) continue;
      const dx = p.x - eye.x, dz = p.z - eye.z;
      let t0 = 0, t1 = 1;
      if (Math.abs(dx) < 1e-9) { if (eye.x < s.x0 || eye.x > s.x1) continue; }
      else {
        let ta = (s.x0 - eye.x) / dx, tb = (s.x1 - eye.x) / dx;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) { if (eye.z < s.z0 || eye.z > s.z1) continue; }
      else {
        let ta = (s.z0 - eye.z) / dz, tb = (s.z1 - eye.z) / dz;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      if (t1 > 0.001 && t0 < 0.999) return false;
    }
    return true;
  }

  return { colliders, solids, shootables, group, nodes, edges, findPath, lineOfSight };
}
