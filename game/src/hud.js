// The DOM HUD: crosshair with a spread gap, hit marker, health and armour, ammo and money,
// the round clock and score, a killfeed, a plant/defuse progress bar, the buy menu, the
// scoreboard and a minimap. It never touches the simulation; main.js pushes state in.
import { PALETTE } from './palette.js';
import { SITES } from './world.js';

const $ = (id) => document.getElementById(id);

export function createHud() {
  const els = {
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    healthFill: $('health-fill'),
    healthText: $('health-text'),
    armorText: $('armor-text'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    ammoBox: $('ammo'),
    weaponName: $('weapon-name'),
    money: $('money'),
    timer: $('timer'),
    phase: $('phase'),
    scoreAttack: $('score-attack'),
    scoreDefend: $('score-defend'),
    killfeed: $('killfeed'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    plantbar: $('plantbar'),
    plantFill: $('plant-fill'),
    plantLabel: $('plant-label'),
    buymenu: $('buymenu'),
    buyItems: $('buy-items'),
    buyMoney: $('buy-money'),
    scoreboard: $('scoreboard'),
    scoreRows: $('score-rows'),
    vignette: $('vignette'),
    bombtag: $('bombtag'),
    map: $('minimap'),
  };
  const mapCtx = els.map.getContext('2d');
  let bannerUntil = 0;
  let hitUntil = 0;

  function banner(title, sub, now, holdMs = 2600) {
    els.bannerTitle.textContent = title;
    els.bannerSub.textContent = sub;
    els.banner.hidden = false;
    bannerUntil = now + holdMs;
  }

  function killfeed(html) {
    const row = document.createElement('div');
    row.className = 'feed-row';
    row.innerHTML = html;
    els.killfeed.appendChild(row);
    while (els.killfeed.children.length > 5) els.killfeed.firstChild.remove();
    setTimeout(() => row.remove(), 4200);
  }

  function setBuyMenu(items, money, onBuy) {
    els.buyMoney.textContent = `$${money}`;
    els.buyItems.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'buy-item';
      btn.disabled = item.owned || money < item.price;
      btn.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.name}</span><span class="buy-price">${item.owned ? 'OWNED' : '$' + item.price}</span><span class="buy-desc">${item.desc}</span>`;
      btn.addEventListener('click', () => onBuy(item.id));
      els.buyItems.appendChild(btn);
    }
  }

  function scoreboard(rows, attackScore, defendScore) {
    els.scoreRows.innerHTML =
      `<div class="sb-teams"><span class="a">ATTACK ${attackScore}</span><span class="d">DEFEND ${defendScore}</span></div>` +
      rows
        .map(
          (r) => `<div class="sb-row ${r.team}"><span class="sb-name">${r.name}${r.alive ? '' : ' ✝'}</span><span>${r.kills}</span><span>${r.deaths}</span><span>$${r.money}</span></div>`,
        )
        .join('');
  }

  function drawMap(world, actors, playerPos, playerYaw) {
    const c = mapCtx;
    const W = els.map.width;
    const H = els.map.height;
    const sx = W / 68;
    const sz = H / 52;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(20,16,10,0.72)';
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(233,230,223,0.16)';
    for (const s of world.solids) {
      if (s.h < 1.2) continue;
      c.fillRect((s.x0 + 34) * sx, (s.z0 + 26) * sz, (s.x1 - s.x0) * sx, (s.z1 - s.z0) * sz);
    }
    for (const [key, site] of Object.entries(SITES)) {
      c.strokeStyle = key === 'A' ? PALETTE.amber : PALETTE.teal;
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc((site.x + 34) * sx, (site.z + 26) * sz, site.r * sx, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = c.strokeStyle;
      c.font = '700 9px system-ui';
      c.fillText(key, (site.x + 34) * sx - 3, (site.z + 26) * sz + 3);
    }
    for (const actor of actors) {
      if (!actor.alive || actor.isPlayer) continue;
      c.fillStyle = actor.team === 'attack' ? PALETTE.amber : PALETTE.teal;
      c.beginPath();
      c.arc((actor.pos.x + 34) * sx, (actor.pos.z + 26) * sz, 2.4, 0, Math.PI * 2);
      c.fill();
    }
    // The player: a wedge pointing the way they face.
    const px = (playerPos.x + 34) * sx;
    const pz = (playerPos.z + 26) * sz;
    c.save();
    c.translate(px, pz);
    c.rotate(Math.atan2(-Math.sin(playerYaw), -Math.cos(playerYaw)) + Math.PI);
    c.fillStyle = PALETTE.ink;
    c.beginPath();
    c.moveTo(0, -5);
    c.lineTo(3.6, 4);
    c.lineTo(-3.6, 4);
    c.closePath();
    c.fill();
    c.restore();
  }

  return {
    els,
    banner,
    killfeed,
    setBuyMenu,
    scoreboard,
    drawMap,
    hit(now, head) {
      els.hitmarker.classList.add('on');
      els.hitmarker.style.setProperty('--hm', head ? PALETTE.amber : PALETTE.ink);
      hitUntil = now + 110;
    },
    update(now, s) {
      if (now > hitUntil) els.hitmarker.classList.remove('on');
      if (now > bannerUntil) els.banner.hidden = true;
      els.crosshair.style.setProperty('--gap', `${6 + Math.round(s.spreadPx)}px`);
      els.crosshair.style.opacity = s.alive && !s.scoped ? '1' : '0';
      els.healthFill.style.width = `${Math.max(0, s.health)}%`;
      els.healthFill.style.background = s.health <= 30 ? '#d64545' : PALETTE.amber;
      els.healthText.textContent = `${Math.max(0, Math.ceil(s.health))}`;
      els.armorText.textContent = s.armor ? '🛡' : '';
      els.ammoMag.textContent = s.weaponId === 'frag' ? `${s.grenades}` : `${s.ammo}`;
      els.ammoReserve.textContent = s.weaponId === 'frag' ? 'FRAG' : `/ ${s.reserve}`;
      els.ammoBox.classList.toggle('empty', s.ammo === 0 && s.weaponId !== 'frag');
      els.weaponName.textContent = s.weaponName;
      els.money.textContent = `$${s.money}`;
      els.timer.textContent = s.clock;
      els.timer.style.color = s.clockUrgent ? '#d64545' : PALETTE.ink;
      els.phase.textContent = s.phaseLabel;
      els.scoreAttack.textContent = `${s.attackScore}`;
      els.scoreDefend.textContent = `${s.defendScore}`;
      els.bombtag.hidden = !s.bombPlanted;
      els.vignette.style.opacity = s.hurt ? '0.55' : '0';
      if (s.plant) {
        els.plantbar.hidden = false;
        els.plantLabel.textContent = s.plant.label;
        els.plantFill.style.width = `${Math.round(s.plant.frac * 100)}%`;
      } else {
        els.plantbar.hidden = true;
      }
      els.buymenu.hidden = !s.buyOpen;
      els.scoreboard.hidden = !s.scoreOpen;
      document.body.classList.toggle('scoped', !!s.scoped);
    },
  };
}
