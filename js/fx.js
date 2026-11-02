// Visual effects: particles, flashes, rings, floating text, screen shake.
(function () {
  const ED = window.ED;
  const { TAU, hexToRgb } = ED.util;
  const MAT = ED.MATERIALS;
  const MAX_PARTS = 4000;

  const matRGB = {};
  for (const k in MAT) matRGB[k] = hexToRgb(MAT[k].color);

  function FX() {
    this.parts = [];
    this.texts = [];
    this.flashes = [];
    this.rings = [];
    this.marks = []; // marks on Earth (craters)
    this.screenFlash = 0;
    this.shake = 0;
    this.t = 0;
  }

  FX.prototype.reset = function () {
    this.parts.length = 0;
    this.texts.length = 0;
    this.flashes.length = 0;
    this.rings.length = 0;
    this.marks.length = 0;
    this.screenFlash = 0;
    this.shake = 0;
  };

  // p: {x,y,vx,vy,life,size,r,g,b,glow,drag,grow}
  FX.prototype.add = function (p) {
    if (this.parts.length >= MAX_PARTS) return;
    p.max = p.life;
    if (p.drag == null) p.drag = 0.4;
    this.parts.push(p);
  };

  // key: texts with the same key close together are not repeated (avoids pile-ups)
  FX.prototype.text = function (x, y, str, color, size, life, key) {
    if (key) {
      for (const t of this.texts) {
        if (t.key === key && t.max - t.life < 0.9 && Math.hypot(t.x - x, t.y - y) < 110) return;
      }
    }
    this.texts.push({ x, y, str, key, color: color || '#fff', size: size || 18, life: life || 1.8, max: life || 1.8, vy: -22 });
  };

  FX.prototype.flash = function (x, y, r, color, life) {
    this.flashes.push({ x, y, r, color: color || '255,240,200', life: life || 0.35, max: life || 0.35 });
  };

  FX.prototype.ring = function (x, y, r0, r1, color, life, width) {
    this.rings.push({ x, y, r0, r1, color: color || '255,255,255', life: life || 0.6, max: life || 0.6, width: width || 3 });
  };

  FX.prototype.update = function (dt) {
    this.t += dt;
    const P = this.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) {
        P[i] = P[P.length - 1];
        P.pop();
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grow) p.size += p.grow * dt;
    }
    for (const list of [this.texts, this.flashes, this.rings]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i];
        o.life -= dt;
        if (o.vy) o.y += o.vy * dt;
        if (o.life <= 0) list.splice(i, 1);
      }
    }
    this.screenFlash = Math.max(0, this.screenFlash - dt * 1.6);
    this.shake = Math.max(0, this.shake - dt * 18);
  };

  // ---------------------------------------------------------------------------
  // Hooks called by the physics world
  // ---------------------------------------------------------------------------
  FX.prototype.hooks = function () {
    const fx = this;
    return {
      dust(x, y, bvx, bvy, dx, dy, speed, mat, style, area) {
        const [r, g, b] = matRGB[mat] || [150, 140, 130];
        const n = style === 'vapor' ? 3 : Math.max(2, Math.round(area / 25));
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * (style === 'vapor' ? 1.6 : 1.1);
          const s = speed * (0.25 + Math.random() * 0.9);
          if (style === 'vapor') {
            fx.add({ x, y, vx: bvx + Math.cos(a) * s, vy: bvy + Math.sin(a) * s, life: 0.5 + Math.random() * 0.8, size: 2 + Math.random() * 3, r: 255, g: 150 + Math.random() * 90, b: 60 + Math.random() * 80, glow: true, drag: 1.2, grow: 6 });
          } else {
            const shade = 0.7 + Math.random() * 0.5;
            fx.add({ x: x + (Math.random() - 0.5) * 4, y: y + (Math.random() - 0.5) * 4, vx: bvx + Math.cos(a) * s, vy: bvy + Math.sin(a) * s, life: 1.2 + Math.random() * 2.2, size: 1 + Math.random() * 2.2, r: r * shade, g: g * shade, b: b * shade, drag: 0.5 });
          }
        }
        if (style === 'ejecta' && Math.random() < 0.5) {
          fx.add({ x, y, vx: bvx + dx * speed * 0.6, vy: bvy + dy * speed * 0.6, life: 1.6, size: 6, r: 200, g: 190, b: 175, drag: 0.9, grow: 14, smoke: true });
        }
      },
      impact(x, y, ux, uy, info) {
        fx.flash(x, y, 26 + info.G * 0.4, '255,245,220', 0.35);
        fx.ring(x, y, 4, 40 + info.G * 0.6, '255,220,170', 0.5, 2);
        fx.shake = Math.max(fx.shake, 5);
        for (let i = 0; i < 26; i++) {
          const a = Math.atan2(-uy, -ux) + (Math.random() - 0.5) * 2.2;
          const s = 80 + Math.random() * 260;
          fx.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.25 + Math.random() * 0.5, size: 1.4 + Math.random() * 1.6, r: 255, g: 200 + Math.random() * 55, b: 120, glow: true, drag: 3 });
        }
      },
      nuke(x, y, info) {
        const big = info.regime === 'buried' ? 1 : info.regime === 'surface' ? 0.8 : 0.65;
        fx.screenFlash = Math.max(fx.screenFlash, big);
        fx.shake = Math.max(fx.shake, 16 * big);
        fx.flash(x, y, 140 * big, '255,255,235', 0.7);
        fx.flash(x, y, 70 * big, '255,170,80', 1.4);
        fx.ring(x, y, 10, 620, '200,220,255', 0.9, 3); // X-ray / neutron pulse
        fx.ring(x, y, 6, 160 * big, '255,190,120', 1.2, 6);
        for (let i = 0; i < 90; i++) {
          const a = Math.random() * TAU, s = 60 + Math.random() * 320 * big;
          fx.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.6 + Math.random() * 1.4, size: 2 + Math.random() * 3, r: 255, g: 140 + Math.random() * 110, b: 60 + Math.random() * 100, glow: true, drag: 1.5, grow: 5 });
        }
      },
      push(body, dx, dy, dv) {
        // vapour jets blasting off the heated side (towards the blast)
        const n = Math.min(40, 6 + dv * 0.6);
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.6;
          const s = 60 + Math.random() * 160;
          const ox = body.x - dx * body.rad * 0.7 + (Math.random() - 0.5) * body.rad * 0.8;
          const oy = body.y - dy * body.rad * 0.7 + (Math.random() - 0.5) * body.rad * 0.8;
          fx.add({ x: ox, y: oy, vx: body.vx + Math.cos(a) * s, vy: body.vy + Math.sin(a) * s, life: 0.5 + Math.random() * 0.7, size: 2 + Math.random() * 2.5, r: 190, g: 220, b: 255, glow: true, drag: 1.4, grow: 8 });
        }
      },
    };
  };

  // Engine exhaust for flying penetrators
  FX.prototype.exhaust = function (p) {
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const ux = p.vx / sp, uy = p.vy / sp;
    const nuke = p.kind === 'nuke';
    this.add({
      x: p.x - ux * 11, y: p.y - uy * 11,
      vx: -ux * 60 + (Math.random() - 0.5) * 30, vy: -uy * 60 + (Math.random() - 0.5) * 30,
      life: 0.25 + Math.random() * 0.2, size: 1.5 + Math.random() * 1.5,
      r: nuke ? 255 : 120, g: nuke ? 170 : 220, b: nuke ? 80 : 255, glow: true, drag: 2,
    });
  };

  // Plasma trail for fragments entering the atmosphere
  FX.prototype.plasma = function (b, scale, sizeM) {
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const ux = b.vx / sp, uy = b.vy / sp;
    const n = 1 + Math.min(4, sizeM / 25);
    for (let i = 0; i < n; i++) {
      const r = b.rad * scale;
      this.add({
        x: b.x + (Math.random() - 0.5) * r, y: b.y + (Math.random() - 0.5) * r,
        vx: -ux * (30 + Math.random() * 50) + (Math.random() - 0.5) * 20,
        vy: -uy * (30 + Math.random() * 50) + (Math.random() - 0.5) * 20,
        life: 0.35 + Math.random() * 0.5, size: 1.5 + Math.random() * (1 + r * 0.25),
        r: 255, g: 150 + Math.random() * 100, b: 60 + Math.random() * 60, glow: true, drag: 1.5, grow: 3,
      });
    }
  };

  FX.prototype.outcome = function (ev) {
    const E = ED.EARTH;
    const o = ED.OUTCOMES[ev.outcome];
    if (ev.outcome === 'burn') {
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * TAU, s = 20 + Math.random() * 60;
        this.add({ x: ev.x, y: ev.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.5, size: 1.2 + Math.random() * 1.5, r: 200, g: 255, b: 230, glow: true, drag: 2.5 });
      }
      this.flash(ev.x, ev.y, 12 + ev.sizeM * 0.6, '220,255,240', 0.3);
    } else if (ev.outcome === 'small' || ev.outcome === 'big') {
      const big = ev.outcome === 'big';
      this.flash(ev.x, ev.y, big ? 70 : 34, big ? '255,200,120' : '255,240,170', big ? 0.9 : 0.55);
      this.ring(ev.x, ev.y, 4, big ? 90 : 45, big ? '255,170,90' : '255,230,150', big ? 1.0 : 0.6, big ? 4 : 2);
      this.shake = Math.max(this.shake, big ? 7 : 2.5);
      this.text(ev.x + 6, ev.y - 10, o.icon + ' ' + Math.round(ev.sizeM) + ' m', o.color, big ? 17 : 14, 1.6, ev.outcome);
    } else if (ev.outcome === 'ground') {
      const sx = E.x + Math.cos(ev.ang) * E.R, sy = E.y + Math.sin(ev.ang) * E.R;
      this.flash(sx, sy, 130, '255,230,170', 1.2);
      this.ring(sx, sy, 6, 200, '255,140,70', 1.4, 7);
      this.shake = Math.max(this.shake, 20);
      this.screenFlash = Math.max(this.screenFlash, 0.45);
      this.marks.push({ ang: ev.ang, size: Math.min(60, 10 + ev.effM * 0.18), t: this.t });
      for (let i = 0; i < 50; i++) {
        const a = ev.ang + (Math.random() - 0.5) * 2.4, s = 40 + Math.random() * 200;
        this.add({ x: sx, y: sy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.6 + Math.random() * 1.2, size: 2 + Math.random() * 3, r: 255, g: 120 + Math.random() * 100, b: 40, glow: true, drag: 1.8 });
      }
      this.text(sx + 20, sy - 20, '☄️ IMPACT! ' + Math.round(ev.sizeM) + ' m', o.color, 22, 2.6);
    }
  };

  ED.FX = FX;
})();
