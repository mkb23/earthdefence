// Canvas renderer.
(function () {
  const ED = window.ED;
  const { TAU, rng, hexToRgb, clamp } = ED.util;
  const MAT = ED.MATERIALS;
  const E = ED.EARTH;
  const VIEW = ED.VIEW;
  const ZONE = ED.ZONE;

  const LX = 0.55, LY = -0.5, LZ = 0.67; // light from the upper right (the Sun)
  const BUCKET = TAU / 24;
  const FONT = 'Fredoka, "Trebuchet MS", system-ui, sans-serif';
  const KIN = '#4fd8ff', NUK = '#ffc23d';

  const matRGB = {};
  for (const k in MAT) matRGB[k] = hexToRgb(MAT[k].color);

  function Renderer(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.gen = 0;
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = W; this.H = H; this.dpr = dpr;
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(H * dpr);
    this.cv.style.width = W + 'px';
    this.cv.style.height = H + 'px';
    this.scale = Math.min(W / VIEW.w, H / VIEW.h);
    this.offX = (W - VIEW.w * this.scale) / 2;
    this.offY = (H - VIEW.h * this.scale) / 2;
    this.px = this.scale * dpr;
    this.gen++;
    this.buildBackground();
    this.buildEarth();
  };

  Renderer.prototype.toWorld = function (cx, cy) {
    const r = this.cv.getBoundingClientRect();
    return [(cx - r.left - this.offX) / this.scale, (cy - r.top - this.offY) / this.scale];
  };
  Renderer.prototype.toScreen = function (wx, wy) {
    return [this.offX + wx * this.scale, this.offY + wy * this.scale];
  };

  // ---------------------------------------------------------------------------
  // Static layers
  // ---------------------------------------------------------------------------
  Renderer.prototype.buildBackground = function () {
    const cv = document.createElement('canvas');
    cv.width = this.cv.width; cv.height = this.cv.height;
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.fillStyle = '#03050e';
    g.fillRect(0, 0, W, H);
    const r = rng(77);
    const neb = [
      [0.62, 0.25, 0.55, 'rgba(70,40,140,0.20)'],
      [0.85, 0.8, 0.45, 'rgba(20,70,130,0.18)'],
      [0.35, 0.7, 0.4, 'rgba(110,40,90,0.10)'],
    ];
    for (const [x, y, rad, col] of neb) {
      const gr = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, rad * Math.max(W, H));
      gr.addColorStop(0, col);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
    }
    // faint Milky Way band
    g.save();
    g.translate(W * 0.5, H * 0.5);
    g.rotate(-0.35);
    for (let i = 0; i < 1400; i++) {
      const x = (r() - 0.5) * W * 1.6, y = (r() + r() + r() - 1.5) * H * 0.12;
      g.fillStyle = `rgba(200,210,255,${0.05 + r() * 0.12})`;
      g.fillRect(x, y, this.dpr, this.dpr);
    }
    g.restore();
    const n = Math.round((W * H) / (2600 * this.dpr * this.dpr));
    for (let i = 0; i < n; i++) {
      const x = r() * W, y = r() * H, s = r();
      const size = (s > 0.985 ? 2.2 : s > 0.9 ? 1.4 : 0.8) * this.dpr;
      const tint = r();
      g.fillStyle = tint > 0.85 ? 'rgba(255,220,190,' : tint > 0.7 ? 'rgba(190,210,255,' : 'rgba(255,255,255,';
      g.fillStyle += (0.35 + r() * 0.65) + ')';
      g.beginPath();
      g.arc(x, y, size * 0.6, 0, TAU);
      g.fill();
    }
    // Sun glow from the upper right
    const sx = this.offX * this.dpr + 1500 * this.px, sy = this.offY * this.dpr - 260 * this.px;
    const sg = g.createRadialGradient(sx, sy, 0, sx, sy, 900 * this.px);
    sg.addColorStop(0, 'rgba(255,240,200,0.35)');
    sg.addColorStop(0.3, 'rgba(255,200,140,0.08)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg;
    g.fillRect(0, 0, W, H);
    this.bg = cv;
    // twinkling stars (drawn live)
    this.twinkles = [];
    for (let i = 0; i < 40; i++) this.twinkles.push([r() * this.W, r() * this.H, r() * TAU, 0.6 + r() * 1.6]);
  };

  Renderer.prototype.buildEarth = function () {
    const x0 = -440, y0 = 0, w = 700, h = 720;
    const px = this.px;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * px); cv.height = Math.ceil(h * px);
    const g = cv.getContext('2d');
    g.setTransform(px, 0, 0, px, -x0 * px, -y0 * px);
    // atmosphere haze
    const ag = g.createRadialGradient(E.x, E.y, E.R * 0.98, E.x, E.y, E.atm + 26);
    ag.addColorStop(0, 'rgba(140,200,255,0.75)');
    ag.addColorStop(0.25, 'rgba(90,160,255,0.38)');
    ag.addColorStop(0.62, 'rgba(60,120,255,0.12)');
    ag.addColorStop(1, 'rgba(40,80,255,0)');
    g.fillStyle = ag;
    g.beginPath(); g.arc(E.x, E.y, E.atm + 26, 0, TAU); g.fill();
    // ocean
    const og = g.createRadialGradient(E.x + 110, E.y - 80, 10, E.x, E.y, E.R);
    og.addColorStop(0, '#4aa3f0');
    og.addColorStop(0.45, '#1f63bf');
    og.addColorStop(1, '#0b2a63');
    g.fillStyle = og;
    g.beginPath(); g.arc(E.x, E.y, E.R, 0, TAU); g.fill();
    g.save();
    g.beginPath(); g.arc(E.x, E.y, E.R, 0, TAU); g.clip();
    const r = rng(2024);
    const blob = (cx, cy, rad, col, pts) => {
      const P = [];
      const n = pts || 22;
      const h = [r() * TAU, r() * TAU, r() * TAU];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        const rr = rad * (0.78 + 0.22 * Math.sin(2 * a + h[0]) + 0.14 * Math.sin(5 * a + h[1]) + 0.08 * Math.sin(9 * a + h[2]) + (r() - 0.5) * 0.12);
        P.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9]);
      }
      g.fillStyle = col;
      g.beginPath();
      for (let k = 0; k <= n; k++) {
        const p = P[k % n], q = P[(k + 1) % n];
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if (k === 0) g.moveTo(mx, my); else g.quadraticCurveTo(p[0], p[1], mx, my);
      }
      g.fill();
    };
    const lands = [[E.x + 120, E.y - 120, 80], [E.x + 160, E.y + 40, 70], [E.x + 60, E.y + 150, 90], [E.x - 60, E.y - 40, 110], [E.x + 200, E.y - 20, 40], [E.x - 120, E.y + 170, 70], [E.x + 30, E.y - 210, 60]];
    for (const [cx, cy, rad] of lands) {
      blob(cx, cy, rad, '#3b8444');
      blob(cx + (r() - 0.5) * rad * 0.5, cy + (r() - 0.5) * rad * 0.5, rad * 0.6, '#4f9a4a');
      blob(cx + (r() - 0.5) * rad * 0.5, cy + (r() - 0.5) * rad * 0.5, rad * 0.28, '#a99a62');
    }
    blob(E.x + 10, E.y - E.R + 4, 85, 'rgba(240,248,255,0.9)');
    blob(E.x + 10, E.y + E.R - 4, 85, 'rgba(240,248,255,0.9)');
    // wispy cloud bands
    g.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * E.R;
      const cx = E.x + Math.cos(a) * d, cy = E.y + Math.sin(a) * d;
      const len = 20 + r() * 60, tilt = (r() - 0.5) * 0.5;
      g.strokeStyle = `rgba(255,255,255,${0.1 + r() * 0.22})`;
      g.lineWidth = 2 + r() * 6;
      g.beginPath();
      g.moveTo(cx - Math.cos(tilt) * len / 2, cy - Math.sin(tilt) * len / 2);
      g.quadraticCurveTo(cx, cy + (r() - 0.5) * 14, cx + Math.cos(tilt) * len / 2, cy + Math.sin(tilt) * len / 2);
      g.stroke();
    }
    // night side shading (sun from upper right)
    const sg = g.createLinearGradient(E.x + E.R * 0.55, E.y - E.R * 0.5, E.x - E.R * 0.7, E.y + E.R * 0.6);
    sg.addColorStop(0, 'rgba(0,0,20,0)');
    sg.addColorStop(0.55, 'rgba(0,0,25,0.35)');
    sg.addColorStop(1, 'rgba(0,0,25,0.85)');
    g.fillStyle = sg;
    g.fillRect(E.x - E.R, E.y - E.R, E.R * 2, E.R * 2);
    g.restore();
    // bright rim
    g.strokeStyle = 'rgba(170,220,255,0.7)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(E.x, E.y, E.R + 1, -1.2, 1.2); g.stroke();
    this.earth = { cv, x0, y0, w, h };
  };

  // ---------------------------------------------------------------------------
  // Frame helpers
  // ---------------------------------------------------------------------------
  Renderer.prototype.begin = function (t, shake) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.bg, 0, 0);
    // twinkles
    for (const [x, y, ph, sp] of this.twinkles) {
      const a = 0.3 + 0.7 * Math.abs(Math.sin(t * sp + ph));
      g.fillStyle = `rgba(255,255,255,${a})`;
      g.fillRect(x * this.dpr, y * this.dpr, 1.6 * this.dpr, 1.6 * this.dpr);
    }
    const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
    g.setTransform(this.px, 0, 0, this.px, (this.offX + sx * this.scale) * this.dpr, (this.offY + sy * this.scale) * this.dpr);
  };

  Renderer.prototype.drawEarth = function (fx, t, opts) {
    const g = this.ctx, e = this.earth;
    g.drawImage(e.cv, e.x0, e.y0, e.w, e.h);
    // craters
    for (const m of fx.marks) {
      const cx = E.x + Math.cos(m.ang) * (E.R - 2), cy = E.y + Math.sin(m.ang) * (E.R - 2);
      g.save();
      g.translate(cx, cy);
      g.rotate(m.ang);
      g.fillStyle = 'rgba(45,28,18,0.9)';
      g.beginPath(); g.ellipse(0, 0, m.size * 0.35, m.size * 0.6, 0, 0, TAU); g.fill();
      const age = fx.t - m.t;
      const glow = Math.max(0.15, 1 - age / 8);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgba(255,${110 + 60 * glow},40,${0.8 * glow})`;
      g.beginPath(); g.ellipse(0, 0, m.size * 0.18, m.size * 0.35, 0, 0, TAU); g.fill();
      g.restore();
    }
    if (opts && opts.labels) {
      g.save();
      g.font = `600 13px ${FONT}`;
      g.fillStyle = 'rgba(170,215,255,0.85)';
      g.translate(E.x, E.y);
      g.rotate(0.6);
      g.textAlign = 'center';
      g.fillText('A T M O S P H E R E', 0, -E.atm + 13);
      g.restore();
      g.setLineDash([4, 6]);
      g.strokeStyle = 'rgba(150,200,255,0.35)';
      g.lineWidth = 1;
      g.beginPath(); g.arc(E.x, E.y, E.atm, -1.3, 1.3); g.stroke();
      g.setLineDash([]);
      g.font = `700 22px ${FONT}`;
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.textAlign = 'left';
      g.fillText('EARTH', 18, E.y + 8);
    }
  };

  Renderer.prototype.drawZone = function (t, active) {
    const g = this.ctx;
    const w = ZONE.x1 - ZONE.x0, h = ZONE.y1 - ZONE.y0;
    g.fillStyle = active ? 'rgba(90,255,170,0.07)' : 'rgba(90,255,170,0.035)';
    g.strokeStyle = active ? `rgba(110,255,180,${0.55 + 0.25 * Math.sin(t * 4)})` : 'rgba(110,255,180,0.35)';
    g.lineWidth = 2;
    g.setLineDash([10, 8]);
    g.beginPath();
    if (g.roundRect) g.roundRect(ZONE.x0, ZONE.y0, w, h, 18); else g.rect(ZONE.x0, ZONE.y0, w, h);
    g.fill(); g.stroke();
    g.setLineDash([]);
    g.font = `600 13px ${FONT}`;
    g.fillStyle = 'rgba(140,255,195,0.8)';
    g.textAlign = 'left';
    g.fillText('SWARM DEPLOYMENT ZONE', ZONE.x0 + 14, ZONE.y1 - 12);
  };

  // ---------------------------------------------------------------------------
  // Asteroid bodies
  // ---------------------------------------------------------------------------
  Renderer.prototype.paintCells = function (g, b, Lx, Ly) {
    const Rb = Math.max(b.rad, 5);
    const cells = b.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.alive) continue;
      const cx = c.gx - b.ox, cy = c.gy - b.oy;
      const nx = (cx / Rb) * 0.9, ny = (cy / Rb) * 0.9;
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, nx * nx + ny * ny)));
      const dif = Math.max(0, nx * Lx + ny * Ly + nz * LZ);
      const shade = (0.3 + 0.8 * dif) * c.tone;
      const base = matRGB[c.mat];
      let r = base[0] * shade, gg = base[1] * shade, bb = base[2] * shade;
      if (c.mat === 'iron') {
        const s = Math.pow(dif, 12) * 140;
        r += s; gg += s; bb += s * 1.1;
      }
      const P = c.poly;
      g.beginPath();
      g.moveTo(P[0] - b.ox, P[1] - b.oy);
      for (let k = 2; k < P.length; k += 2) g.lineTo(P[k] - b.ox, P[k + 1] - b.oy);
      g.closePath();
      g.fillStyle = `rgb(${r | 0},${gg | 0},${bb | 0})`;
      g.fill();
      const ek = c.mat === 'fluff' ? 0.9 : c.mat === 'shell' ? 0.62 : 0.78;
      g.strokeStyle = `rgb(${(r * ek) | 0},${(gg * ek) | 0},${(bb * ek) | 0})`;
      g.lineWidth = c.mat === 'shell' ? 0.9 : 0.6;
      g.stroke();
    }
    // cracks that haven't split the body (yet)
    g.beginPath();
    let any = false;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.alive) continue;
      for (const bond of c.bonds) {
        if (bond.a !== c || !bond.broken) continue;
        const o = bond.b;
        if (!o.alive || o.body !== b) continue;
        const e = bond.e;
        g.moveTo(e[0] - b.ox, e[1] - b.oy);
        g.lineTo(e[2] - b.ox, e[3] - b.oy);
        any = true;
      }
    }
    if (any) {
      g.strokeStyle = 'rgba(20,10,6,0.9)';
      g.lineWidth = 1.3;
      g.stroke();
    }
  };

  Renderer.prototype.sprite = function (b) {
    const q = Math.round(b.a / BUCKET);
    const s = b.sprite;
    if (s && !b.dirty && s.q === q && s.gen === this.gen) return s;
    const px = this.px;
    const R = b.rad + 2;
    const size = Math.max(4, Math.ceil(2 * R * px));
    let cv = s && s.cv;
    if (!cv || cv.width < size || cv.width > size * 1.6) {
      cv = document.createElement('canvas');
      cv.width = cv.height = size;
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(px, 0, 0, px, cv.width / 2, cv.height / 2);
    const la = -q * BUCKET, c = Math.cos(la), sn = Math.sin(la);
    this.paintCells(g, b, c * LX - sn * LY, sn * LX + c * LY);
    b.dirty = false;
    b.sprite = { cv, q, gen: this.gen, half: cv.width / 2 / px };
    return b.sprite;
  };

  Renderer.prototype.drawBody = function (b, opts) {
    const g = this.ctx;
    const scale = (opts && opts.scale) || 1;
    const alpha = opts && opts.alpha != null ? opts.alpha : 1;
    const x = opts && opts.x != null ? opts.x : b.x;
    const y = opts && opts.y != null ? opts.y : b.y;
    const a = opts && opts.a != null ? opts.a : b.a;
    g.save();
    g.globalAlpha = alpha;
    g.translate(x, y);
    g.rotate(a);
    if (scale !== 1) g.scale(scale, scale);
    if (b.cells.length <= 5) {
      const c = Math.cos(-a), s = Math.sin(-a);
      this.paintCells(g, b, c * LX - s * LY, s * LX + c * LY);
    } else {
      const sp = this.sprite(b);
      g.drawImage(sp.cv, -sp.half, -sp.half, sp.half * 2, sp.half * 2);
    }
    g.restore();
    const heat = opts && opts.heat != null ? opts.heat : b.heat;
    if (heat > 0.03) this.glow(x, y, b.rad * scale * 1.25 + 6, heat, opts && opts.hot);
  };

  Renderer.prototype.glow = function (x, y, r, heat, hot) {
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = 'lighter';
    if (r < 10) {
      g.fillStyle = hot ? `rgba(255,210,150,${0.5 * heat})` : `rgba(255,120,50,${0.45 * heat})`;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    } else {
      const gr = g.createRadialGradient(x, y, r * 0.2, x, y, r);
      gr.addColorStop(0, hot ? `rgba(255,230,180,${0.65 * heat})` : `rgba(255,140,60,${0.5 * heat})`);
      gr.addColorStop(1, 'rgba(255,80,20,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    g.restore();
  };

  Renderer.prototype.drawCrackGlows = function (world) {
    if (!world.crackGlows.length) return;
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineWidth = 1.6;
    const buckets = [[], [], [], [], []];
    for (const cg of world.crackGlows) {
      const age = world.t - cg.t;
      const k = Math.min(4, Math.floor((age / 1.5) * 5));
      buckets[k].push(cg.bond);
    }
    for (let k = 0; k < 5; k++) {
      if (!buckets[k].length) continue;
      g.strokeStyle = `rgba(255,${150 + k * 15},70,${0.9 - k * 0.18})`;
      g.beginPath();
      for (const bond of buckets[k]) {
        const host = bond.a.alive ? bond.a.body : bond.b.body;
        if (!host || !(host.active || host.entering)) continue;
        const e = bond.e;
        const p = host.toWorld(e[0], e[1]), q = host.toWorld(e[2], e[3]);
        g.moveTo(p[0], p[1]);
        g.lineTo(q[0], q[1]);
      }
      g.stroke();
    }
    g.restore();
  };

  // ---------------------------------------------------------------------------
  // Penetrators
  // ---------------------------------------------------------------------------
  Renderer.prototype.drawPen = function (x, y, ang, kind, o) {
    const g = this.ctx;
    o = o || {};
    g.save();
    g.translate(x, y);
    if (o.selected || o.hover) {
      g.strokeStyle = o.selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
      g.lineWidth = 2;
      g.setLineDash(o.selected ? [] : [3, 3]);
      g.beginPath(); g.arc(0, 0, 17, 0, TAU); g.stroke();
      g.setLineDash([]);
    }
    g.rotate(ang);
    if (o.flame) {
      const f = 0.75 + Math.random() * 0.5;
      const gr = g.createLinearGradient(-10, 0, -10 - 18 * f, 0);
      gr.addColorStop(0, kind === 'nuke' ? 'rgba(255,220,140,0.95)' : 'rgba(200,245,255,0.95)');
      gr.addColorStop(1, kind === 'nuke' ? 'rgba(255,90,20,0)' : 'rgba(40,140,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(-9, -3); g.lineTo(-10 - 18 * f, 0); g.lineTo(-9, 3); g.fill();
    }
    if (kind === 'kinetic') {
      const gr = g.createLinearGradient(0, -5, 0, 5);
      gr.addColorStop(0, '#f2f7ff'); gr.addColorStop(0.5, '#a9b8cc'); gr.addColorStop(1, '#5d6b80');
      g.fillStyle = '#7b8aa0';
      g.beginPath(); g.moveTo(-6, -3); g.lineTo(-11, -7); g.lineTo(-9, -2); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(-6, 3); g.lineTo(-11, 7); g.lineTo(-9, 2); g.closePath(); g.fill();
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(7, -3.2); g.lineTo(-10, -3.6); g.lineTo(-10, 3.6); g.lineTo(7, 3.2); g.closePath(); g.fill();
      g.fillStyle = '#2b3240';
      g.beginPath(); g.moveTo(7, -3.2); g.lineTo(14, 0); g.lineTo(7, 3.2); g.closePath(); g.fill();
      g.fillStyle = KIN;
      g.fillRect(-4, -3.6, 2.5, 7.2);
    } else {
      g.fillStyle = '#c4271f';
      g.beginPath(); g.moveTo(-7, -4); g.lineTo(-12, -8); g.lineTo(-10, -2); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(-7, 4); g.lineTo(-12, 8); g.lineTo(-10, 2); g.closePath(); g.fill();
      const gr = g.createLinearGradient(0, -5, 0, 5);
      gr.addColorStop(0, '#fff2a8'); gr.addColorStop(0.5, '#ffc23d'); gr.addColorStop(1, '#b97c08');
      g.fillStyle = gr;
      g.beginPath();
      if (g.roundRect) g.roundRect(-10, -4.6, 18, 9.2, 3); else g.rect(-10, -4.6, 18, 9.2);
      g.fill();
      g.fillStyle = '#d8342a';
      g.beginPath(); g.moveTo(8, -4); g.lineTo(14, 0); g.lineTo(8, 4); g.closePath(); g.fill();
      // trefoil
      g.fillStyle = '#1b1b1b';
      for (let k = 0; k < 3; k++) {
        const a0 = (k / 3) * TAU - Math.PI / 6;
        g.beginPath(); g.moveTo(-1, 0); g.arc(-1, 0, 3.6, a0, a0 + Math.PI / 3); g.closePath(); g.fill();
      }
      g.fillStyle = '#ffc23d';
      g.beginPath(); g.arc(-1, 0, 0.9, 0, TAU); g.fill();
    }
    g.restore();
    if (o.label) {
      g.font = `700 11px ${FONT}`;
      g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.beginPath(); g.arc(x - 13, y - 13, 8, 0, TAU); g.fill();
      g.fillStyle = kind === 'nuke' ? NUK : KIN;
      g.fillText(o.label, x - 13, y - 9);
    }
  };

  // ---------------------------------------------------------------------------
  // Planning overlays
  // ---------------------------------------------------------------------------
  Renderer.prototype.drawAsteroidPath = function (T, t) {
    const g = this.ctx;
    const end = T.impactStep > 0 ? T.impactStep : T.px.length - 1;
    g.save();
    g.setLineDash([3, 9]);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,90,100,0.55)';
    g.beginPath();
    g.moveTo(T.px[0], T.py[0]);
    for (let i = 10; i <= end; i += 10) g.lineTo(T.px[i], T.py[i]);
    g.lineTo(T.px[end], T.py[end]);
    g.stroke();
    g.setLineDash([]);
    if (T.impactStep > 0) {
      const x = T.px[end], y = T.py[end];
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      g.strokeStyle = `rgba(255,70,90,${0.5 + 0.4 * pulse})`;
      g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, 16 + 6 * pulse, 0, TAU); g.stroke();
      g.font = `700 13px ${FONT}`;
      g.fillStyle = '#ff6b78';
      g.textAlign = 'left';
      g.fillText('⚠ HEADING FOR EARTH', x + 26, y + 5);
    }
    g.restore();
  };

  Renderer.prototype.drawPrediction = function (pen, pr, o) {
    const g = this.ctx;
    const col = pen.kind === 'nuke' ? '255,194,61' : '79,216,255';
    const P = pr.path;
    g.save();
    g.setLineDash([2, 6]);
    g.lineWidth = o.selected ? 2.2 : 1.5;
    g.strokeStyle = `rgba(${col},${o.selected ? 0.95 : 0.6})`;
    g.beginPath();
    g.moveTo(P[0], P[1]);
    for (let i = 2; i < P.length; i += 2) g.lineTo(P[i], P[i + 1]);
    g.stroke();
    g.setLineDash([]);
    const ex = P[P.length - 2], ey = P[P.length - 1];
    if (pr.hit) {
      g.strokeStyle = `rgba(${col},1)`;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(ex - 6, ey - 6); g.lineTo(ex + 6, ey + 6);
      g.moveTo(ex + 6, ey - 6); g.lineTo(ex - 6, ey + 6);
      g.stroke();
      if (pr.standoff) {
        g.setLineDash([2, 3]);
        g.beginPath(); g.arc(ex, ey, 9, 0, TAU); g.stroke();
        g.setLineDash([]);
      }
    } else {
      g.font = `700 13px ${FONT}`;
      g.fillStyle = '#ff6b78';
      g.textAlign = 'center';
      g.fillText('MISS!', clamp(ex, 30, VIEW.w - 30), clamp(ey - 8, 70, VIEW.h - 90));
    }
    g.restore();
  };

  // Mission-computer hologram: where every bit of rock (and every penetrator) will be at time T
  Renderer.prototype.drawHologram = function (rec, T) {
    const g = this.ctx;
    const [k, u] = rec.frameAt(T);
    const A = rec.frames[k], B = rec.frames[k + 1] || A;
    g.save();
    g.beginPath();
    for (let id = 0; id < rec.n; id++) {
      const ax = A[2 * id];
      if (ax !== ax) continue;
      const ay = A[2 * id + 1];
      let bx = B[2 * id], by = B[2 * id + 1];
      if (bx !== bx) { bx = ax; by = ay; }
      const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, r = rec.r[id] * 1.15;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
    g.fillStyle = 'rgba(110,215,255,0.34)';
    g.fill();
    g.strokeStyle = 'rgba(160,235,255,0.25)';
    g.lineWidth = 0.6;
    g.stroke();
    // penetrators in flight
    const PA = rec.penFrames[k], PB = rec.penFrames[k + 1] || PA;
    for (let i = 0; i < rec.np; i++) {
      if (PA[3 * i + 2] !== 1) continue;
      const x = PA[3 * i] + (PB[3 * i] - PA[3 * i]) * u, y = PA[3 * i + 1] + (PB[3 * i + 1] - PA[3 * i + 1]) * u;
      const ang = Math.atan2(PB[3 * i + 1] - PA[3 * i + 1], PB[3 * i] - PA[3 * i]);
      g.globalAlpha = 0.65;
      this.drawPen(x, y, ang, rec.w.pens[i].kind, {});
      g.globalAlpha = 1;
    }
    // impacts happening right now
    for (const im of rec.impacts) {
      const d = T - im.t;
      if (d < 0 || d > 0.45) continue;
      const a = 1 - d / 0.45;
      g.strokeStyle = im.kind === 'nuke' ? `rgba(255,190,90,${a})` : `rgba(255,235,180,${a})`;
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(im.x, im.y, 6 + d * (im.kind === 'nuke' ? 260 : 80), 0, TAU); g.stroke();
    }
    g.restore();
    this.label(VIEW.w - 16, 84, '🔮 HOLOGRAM · T+' + T.toFixed(1) + ' s', '#9fe3ff', 14, 'right');
  };

  // Target reticle on the asteroid where a penetrator will strike
  Renderer.prototype.drawReticle = function (x, y, kind, label, strong) {
    const g = this.ctx;
    const col = kind === 'nuke' ? NUK : KIN;
    g.save();
    g.strokeStyle = col;
    g.globalAlpha = strong ? 1 : 0.8;
    g.lineWidth = strong ? 2.2 : 1.6;
    g.beginPath(); g.arc(x, y, 7, 0, TAU); g.stroke();
    g.beginPath();
    g.moveTo(x - 11, y); g.lineTo(x - 4, y);
    g.moveTo(x + 4, y); g.lineTo(x + 11, y);
    g.moveTo(x, y - 11); g.lineTo(x, y - 4);
    g.moveTo(x, y + 4); g.lineTo(x, y + 11);
    g.stroke();
    if (label) {
      g.font = `700 11px ${FONT}`;
      g.fillStyle = col;
      g.textAlign = 'left';
      g.fillText(label, x + 9, y - 8);
    }
    g.restore();
  };

  Renderer.prototype.drawAimArrow = function (pen, k, selected, big) {
    const g = this.ctx;
    const hx = pen.x + pen.vx * k, hy = pen.y + pen.vy * k;
    const col = pen.kind === 'nuke' ? NUK : KIN;
    g.save();
    g.strokeStyle = col;
    g.globalAlpha = selected ? 1 : 0.55;
    g.lineWidth = selected ? 3 : 2;
    g.beginPath(); g.moveTo(pen.x, pen.y); g.lineTo(hx, hy); g.stroke();
    const a = Math.atan2(pen.vy, pen.vx);
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(hx + Math.cos(a) * 8, hy + Math.sin(a) * 8);
    g.lineTo(hx + Math.cos(a + 2.5) * 9, hy + Math.sin(a + 2.5) * 9);
    g.lineTo(hx + Math.cos(a - 2.5) * 9, hy + Math.sin(a - 2.5) * 9);
    g.closePath(); g.fill();
    if (selected) {
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(10,20,40,0.85)';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      const hr = big ? 14 : 9;
      g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(hx, hy, big ? 4.5 : 3, 0, TAU); g.fill();
    }
    g.restore();
    return [hx, hy];
  };

  // ---------------------------------------------------------------------------
  // Effects, labels
  // ---------------------------------------------------------------------------
  Renderer.prototype.drawParticles = function (fx) {
    const g = this.ctx;
    const P = fx.parts;
    // normal particles (dust, smoke)
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.glow) continue;
      const a = Math.min(1, p.life / p.max * 1.6) * (p.smoke ? 0.25 : 0.9);
      g.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`;
      if (p.smoke) {
        g.beginPath(); g.arc(p.x, p.y, p.size, 0, TAU); g.fill();
      } else {
        g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!p.glow) continue;
      const a = Math.min(1, (p.life / p.max) * 1.4);
      g.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a * 0.85})`;
      g.beginPath(); g.arc(p.x, p.y, p.size, 0, TAU); g.fill();
    }
    g.restore();
  };

  Renderer.prototype.drawFlashes = function (fx) {
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const f of fx.flashes) {
      const k = f.life / f.max;
      const r = f.r * (1.2 - 0.4 * k);
      const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      gr.addColorStop(0, `rgba(${f.color},${0.95 * k})`);
      gr.addColorStop(0.4, `rgba(${f.color},${0.4 * k})`);
      gr.addColorStop(1, `rgba(${f.color},0)`);
      g.fillStyle = gr;
      g.beginPath(); g.arc(f.x, f.y, r, 0, TAU); g.fill();
    }
    for (const rg of fx.rings) {
      const k = 1 - rg.life / rg.max;
      const r = rg.r0 + (rg.r1 - rg.r0) * (1 - Math.pow(1 - k, 2));
      g.strokeStyle = `rgba(${rg.color},${(1 - k) * 0.8})`;
      g.lineWidth = rg.width * (1 - k * 0.5);
      g.beginPath(); g.arc(rg.x, rg.y, r, 0, TAU); g.stroke();
    }
    g.restore();
  };

  Renderer.prototype.drawTexts = function (fx) {
    const g = this.ctx;
    g.textAlign = 'center';
    for (const t of fx.texts) {
      const a = Math.min(1, t.life / (t.max * 0.4));
      g.font = `700 ${t.size}px ${FONT}`;
      g.globalAlpha = a;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.strokeText(t.str, t.x, t.y);
      g.fillStyle = t.color;
      g.fillText(t.str, t.x, t.y);
    }
    g.globalAlpha = 1;
  };

  Renderer.prototype.label = function (x, y, str, color, size, align) {
    const g = this.ctx;
    g.font = `700 ${size || 12}px ${FONT}`;
    g.textAlign = align || 'left';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(str, x, y);
    g.fillStyle = color;
    g.fillText(str, x, y);
  };

  // Dangerous fragments: dashed line to where they will hit the atmosphere + size tag
  Renderer.prototype.drawThreat = function (b, hit, cls, effM, sizeM) {
    const g = this.ctx;
    const col = ED.OUTCOMES[cls].color;
    if (hit && cls !== 'burn') {
      g.save();
      g.globalAlpha = cls === 'small' ? 0.35 : 0.7;
      g.strokeStyle = col;
      g.setLineDash([3, 6]);
      g.lineWidth = cls === 'ground' ? 2 : 1.2;
      g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(hit.x, hit.y); g.stroke();
      g.restore();
    }
    if (cls !== 'burn' && cls !== 'small') this.label(b.x + b.rad + 4, b.y - b.rad * 0.5, Math.round(sizeM) + ' m', col, 12);
  };

  Renderer.prototype.drawNukeMeter = function (p, st) {
    if (!st || st.regime === 'far') return;
    const g = this.ctx;
    const map = {
      standoff: ['#7cc4ff', '📡 STANDOFF ' + Math.round(st.distM) + ' m'],
      surface: ['#ffd84d', '💥 SURFACE'],
      buried: ['#ff5d5d', '⛏️ BURIED!'],
    };
    const [col, txt] = map[st.regime];
    g.save();
    g.font = `700 13px ${FONT}`;
    const w = g.measureText(txt).width + 18;
    const x = clamp(p.x - w / 2, 4, VIEW.w - w - 4), y = p.y - 40;
    g.fillStyle = 'rgba(8,12,28,0.85)';
    g.strokeStyle = col;
    g.lineWidth = 2;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, 22, 11); else g.rect(x, y, w, 22);
    g.fill(); g.stroke();
    g.fillStyle = col;
    g.textAlign = 'center';
    g.fillText(txt, x + w / 2, y + 16);
    g.restore();
  };

  Renderer.prototype.screenFlash = function (a, color) {
    if (a <= 0.01) return;
    const g = this.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = `rgba(${color || '255,255,245'},${Math.min(1, a)})`;
    g.fillRect(0, 0, this.cv.width, this.cv.height);
    g.restore();
  };

  ED.Renderer = Renderer;
  ED.COLORS = { KIN, NUK, FONT };
})();
