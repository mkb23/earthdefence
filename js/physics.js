// Earth Defence – 2D fracture physics engine.
//
// Each asteroid is built from Voronoi "cells" of rock joined by breakable bonds.
// Connected groups of cells form rigid bodies that move, spin and collide.
// Impacts pulverise cells, run cracks through the bond network and break bonds,
// then every connected group of cells that is left becomes its own fragment.
(function () {
  const ED = window.ED;
  const { TAU, rng, clamp, smoothstep, segIntersect, segParam } = ED.util;
  const MAT = ED.MATERIALS;
  const EARTH = ED.EARTH;
  const VIEW = ED.VIEW;
  const SCALE = ED.SCALE;

  const DT = 1 / 240;
  const PEN_R = 3;
  const GM = 3.2e5;
  const G_FADE0 = 650;
  const G_FADE1 = 1000;
  const REF_CELL = 87; // area (px²) of a typical cell with spacing 10
  const REF_MASS = 100 * REF_CELL; // "a hundred rock cells"
  const PACK = 1.45; // Poisson sampling: area per cell / d²
  const U = 9; // px: length unit for blast and crater sizes
  const BURIED = 0.72; // confinement needed to count as a buried blast
  const CRUMB = 2; // bodies this small (in cells) are crumbs: penetrators punch straight through

  // Balance knobs
  const K = {
    PUSH: 9.0, // kinetic momentum push
    CRUSH: 2.2, // energy needed to pulverise one cell
    PEN_FRAC: 0.45, // share of kinetic energy available for digging a crater
    CRACK: 2.6, // kinetic crack energy factor
    KICK: 0.9, // share of fracture energy that flings fragments apart
    KICK_V: 3.4, // velocity scale for fragment kicks
    NUKE_CRACK: 0.42,
    NUKE_KICK: 0.3,
    SO_PUSH: 800, // standoff radiation push
    VMAX: 170,
    STANDOFF: 40, // px: auto standoff fuse height
  };

  const tntTons = (kg, kms) => (0.5 * kg * (kms * 1000) * (kms * 1000)) / 4.184e9;
  // Compress huge energy ranges into game-sized effects
  const gameEnergy = (tons) => 60 * Math.sqrt(Math.max(0, tons) / 60);

  let gax = 0, gay = 0;
  function gravity(x, y) {
    const dx = EARTH.x - x, dy = EARTH.y - y;
    const r2 = dx * dx + dy * dy;
    const r = Math.sqrt(r2);
    const fade = 1 - smoothstep(G_FADE0, G_FADE1, r);
    if (fade <= 0 || r < 1) { gax = 0; gay = 0; return; }
    const a = (GM / r2) * fade;
    gax = (dx / r) * a;
    gay = (dy / r) * a;
  }

  // ---------------------------------------------------------------------------
  // Spatial hash (uniform grid with linked lists in typed arrays)
  // ---------------------------------------------------------------------------
  function Hash(size) {
    this.size = size;
    this.x0 = -800;
    this.y0 = -700;
    this.nx = Math.ceil(3000 / size);
    this.ny = Math.ceil(2200 / size);
    this.head = new Int32Array(this.nx * this.ny).fill(-1);
    this.next = new Int32Array(2048);
  }
  Hash.prototype.reset = function (n) {
    this.head.fill(-1);
    if (this.next.length < n) this.next = new Int32Array(n * 2);
  };
  Hash.prototype.insert = function (id, x, y) {
    const ix = Math.floor((x - this.x0) / this.size), iy = Math.floor((y - this.y0) / this.size);
    if (ix < 0 || iy < 0 || ix >= this.nx || iy >= this.ny) return;
    const b = iy * this.nx + ix;
    this.next[id] = this.head[b];
    this.head[b] = id;
  };

  // ---------------------------------------------------------------------------
  // Cells, bonds and bodies
  // ---------------------------------------------------------------------------
  function Cell(id, ast, gx, gy, mat) {
    this.id = id;
    this.ast = ast;
    this.gx = gx; // position in the asteroid's "generation" frame
    this.gy = gy;
    this.mat = mat;
    this.poly = null; // flat [x0,y0,x1,y1,...] in generation frame
    this.area = 0;
    this.mass = 0;
    this.r = 0; // collision radius
    this.ext = 0; // furthest polygon vertex from site
    this.bonds = [];
    this.alive = true;
    this.body = null;
    this.boundary = false;
    this.boulder = -1;
    this.tone = 1;
    this.wx = 0;
    this.wy = 0;
    this.stamp = 0;
  }

  function Bond(a, b, s, edge) {
    this.a = a;
    this.b = b;
    this.s = s; // strength
    this.e = edge; // shared edge in generation frame [x1,y1,x2,y2]
    this.broken = false;
    this.stamp = 0;
  }

  let bodySeq = 1;
  function Body(ast) {
    this.id = bodySeq++;
    this.ast = ast;
    this.cells = [];
    this.ox = 0; this.oy = 0; // centre of mass in generation frame
    this.x = 0; this.y = 0; this.a = 0;
    this.vx = 0; this.vy = 0; this.w = 0;
    this.mass = 1; this.invM = 1; this.inertia = 1; this.invI = 1;
    this.rad = 0; this.area = 0;
    this.heat = 0;
    this.active = true;
    this.needsSplit = false;
    this.dirty = true; // sprite needs re-render
    this.blastId = 0;
    this.sprite = null;
  }
  Body.prototype.recompute = function () {
    let m = 0, cx = 0, cy = 0;
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      m += c.mass; cx += c.mass * c.gx; cy += c.mass * c.gy;
    }
    cx /= m; cy /= m;
    let I = 0, rad = 0, area = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const dx = c.gx - cx, dy = c.gy - cy;
      const r2 = dx * dx + dy * dy;
      I += c.mass * (r2 + c.r * c.r * 0.5);
      const rr = Math.sqrt(r2) + c.ext;
      if (rr > rad) rad = rr;
      area += c.area;
    }
    this.mass = m; this.invM = 1 / m;
    this.inertia = I; this.invI = 1 / I;
    this.rad = rad; this.area = area;
    return [cx, cy];
  };
  Body.prototype.sizeM = function () {
    return 2 * Math.sqrt(this.area / Math.PI) * this.ast.mpp;
  };
  Body.prototype.entryFactor = function () {
    let s = 0, a = 0;
    for (const c of this.cells) { s += MAT[c.mat].entry * c.area; a += c.area; }
    return a > 0 ? s / a : 1;
  };
  Body.prototype.effM = function () {
    return this.sizeM() * this.entryFactor();
  };
  Body.prototype.toWorld = function (gx, gy) {
    const c = Math.cos(this.a), s = Math.sin(this.a);
    const lx = gx - this.ox, ly = gy - this.oy;
    return [this.x + c * lx - s * ly, this.y + s * lx + c * ly];
  };
  Body.prototype.toGen = function (wx, wy) {
    const c = Math.cos(this.a), s = Math.sin(this.a);
    const dx = wx - this.x, dy = wy - this.y;
    return [c * dx + s * dy + this.ox, -s * dx + c * dy + this.oy];
  };

  function applyImpulse(b, px, py, jx, jy) {
    b.vx += jx * b.invM;
    b.vy += jy * b.invM;
    b.w += ((px - b.x) * jy - (py - b.y) * jx) * b.invI;
  }

  // ---------------------------------------------------------------------------
  // Asteroid generation
  // ---------------------------------------------------------------------------
  function poisson(r, B, d, inside) {
    const cs = d / Math.SQRT2;
    const gw = Math.ceil((2 * B) / cs);
    const grid = new Int32Array(gw * gw).fill(-1);
    const pts = [];
    const active = [];
    const put = (x, y) => {
      const i = pts.length;
      pts.push([x, y]);
      active.push(i);
      grid[Math.floor((y + B) / cs) * gw + Math.floor((x + B) / cs)] = i;
    };
    put((r() - 0.5) * d * 0.2, (r() - 0.5) * d * 0.2);
    while (active.length) {
      const ai = Math.floor(r() * active.length);
      const p = pts[active[ai]];
      let found = false;
      for (let k = 0; k < 26; k++) {
        const a = r() * TAU, rr = d * (1 + r() * 0.5);
        const x = p[0] + Math.cos(a) * rr, y = p[1] + Math.sin(a) * rr;
        if (x <= -B || y <= -B || x >= B || y >= B || !inside(x, y)) continue;
        const gx = Math.floor((x + B) / cs), gy = Math.floor((y + B) / cs);
        let ok = true;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(gw - 1, gy + 2) && ok; yy++) {
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
            const j = grid[yy * gw + xx];
            if (j >= 0) {
              const q = pts[j];
              const dx = q[0] - x, dy = q[1] - y;
              if (dx * dx + dy * dy < d * d) { ok = false; break; }
            }
          }
        }
        if (ok) { put(x, y); found = true; break; }
      }
      if (!found) { active[ai] = active[active.length - 1]; active.pop(); }
    }
    return pts;
  }

  // Sutherland–Hodgman clip of a tagged polygon against half-plane (v-m)·n <= 0
  function clipPoly(vx, vy, tags, mx, my, nx, ny, tagNew) {
    const ox = [], oy = [], ot = [];
    const n = vx.length;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const ax = vx[k], ay = vy[k], bx = vx[k2], by = vy[k2];
      const da = (ax - mx) * nx + (ay - my) * ny;
      const db = (bx - mx) * nx + (by - my) * ny;
      const ain = da <= 0, bin = db <= 0;
      if (ain) { ox.push(ax); oy.push(ay); ot.push(tags[k]); }
      if (ain !== bin) {
        const t = da / (da - db);
        ox.push(ax + (bx - ax) * t); oy.push(ay + (by - ay) * t);
        ot.push(ain ? tagNew : tags[k]);
      }
    }
    return [ox, oy, ot];
  }

  function materialFor(type, rn) {
    switch (type) {
      case 'solid': return 'rock';
      case 'iron': return 'iron';
      case 'rubble': return 'rubble';
      case 'fluffy': return rn < 0.56 ? 'core' : 'fluff';
      case 'pinata': return rn > 0.76 ? 'shell' : 'rubble';
      default: return 'rock';
    }
  }

  function bondStrength(a, b, r) {
    const ma = MAT[a.mat], mb = MAT[b.mat];
    let s;
    if (a.mat === 'rubble' && b.mat === 'rubble') s = a.boulder === b.boulder ? ma.strength : ma.loose;
    else if (a.mat === 'rubble' || b.mat === 'rubble') s = MAT.rubble.loose * 1.6;
    else s = Math.min(ma.strength, mb.strength);
    return s * (0.75 + 0.5 * r());
  }

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------
  const NOFX = { dust() {}, impact() {}, nuke() {}, push() {} };

  function World(seed) {
    this.cells = [];
    this.bodies = [];
    this.pens = [];
    this.asts = [];
    this.entries = [];
    this.events = [];
    this.crackGlows = [];
    this.t = 0;
    this.stamp = 1;
    this.blastSeq = 1;
    this.hash = new Hash(12);
    this.rand = rng(seed || 1234);
    this.fx = NOFX;
    this.maxD = 10;
    this.maxR = 6;
  }

  World.prototype.addAsteroid = function (spec) {
    const r = rng(spec.seed * 9973 + 17);
    const R0 = spec.radiusPx;
    const mpp = spec.diameterM / (2 * R0);
    const cellPx = (spec.cellM || 11) / mpp; // equivalent diameter of one cell, px
    const d = Math.sqrt((Math.PI * cellPx * cellPx) / 4 / PACK);
    const harm = [];
    for (let k = 2; k <= 7; k++) harm.push([k, ((r() * 2 - 1) * 0.17) / Math.pow(k, 0.85), r() * TAU]);
    const elong = spec.elong || 0, elongPh = r() * TAU;
    const shapeR = (th) => {
      let v = 1 + elong * Math.cos(2 * (th - elongPh));
      for (const h of harm) v += h[1] * Math.sin(h[0] * th + h[2]);
      return R0 * Math.max(0.6, v);
    };
    const B = R0 * (1.45 + elong);
    const pts = poisson(r, B, d, (x, y) => Math.hypot(x, y) <= shapeR(Math.atan2(y, x)));

    const ast = {
      id: this.asts.length,
      spec,
      type: spec.type,
      d,
      mpp,
      shapeR,
      cells: [],
    };
    this.asts.push(ast);
    this.maxD = Math.max(this.maxD, d);
    this.maxR = Math.max(this.maxR, d * 0.5);

    // Cells + materials
    const base = this.cells.length;
    const n = pts.length;
    const cells = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      const rn = Math.hypot(x, y) / shapeR(Math.atan2(y, x)) + (r() - 0.5) * 0.07;
      const c = new Cell(base + i, ast, x, y, materialFor(spec.type, rn));
      c.tone = 0.86 + r() * 0.28;
      c.r = d * 0.49;
      c.rn = rn;
      cells.push(c);
    }
    // Boulders inside rubble
    const rubble = cells.filter((c) => c.mat === 'rubble');
    if (rubble.length) {
      const seeds = [];
      const nSeeds = Math.max(1, Math.round(rubble.length / 6.5));
      for (let k = 0; k < nSeeds; k++) seeds.push(rubble[Math.floor(r() * rubble.length)]);
      const tones = seeds.map(() => 0.8 + r() * 0.4);
      for (const c of rubble) {
        let best = 0, bd = Infinity;
        for (let k = 0; k < seeds.length; k++) {
          const dd = (seeds[k].gx - c.gx) ** 2 + (seeds[k].gy - c.gy) ** 2;
          if (dd < bd) { bd = dd; best = k; }
        }
        c.boulder = best;
        c.tone = tones[best] * (0.94 + r() * 0.12);
      }
    }

    // Neighbour lists
    const nb = Array.from({ length: n }, () => []);
    const R2 = (2.6 * d) ** 2;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
        if (dx * dx + dy * dy < R2) { nb[i].push(j); nb[j].push(i); }
      }
    }

    // Voronoi cells by half-plane clipping, remembering which neighbour made each edge
    const edges = new Map();
    for (let i = 0; i < n; i++) {
      const [sx, sy] = pts[i];
      let vx = [], vy = [], tags = [];
      const R1 = 2.2 * d;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU + 0.13;
        vx.push(sx + Math.cos(a) * R1); vy.push(sy + Math.sin(a) * R1); tags.push(-1);
      }
      const list = nb[i].slice().sort((a, b) => {
        const da = (pts[a][0] - sx) ** 2 + (pts[a][1] - sy) ** 2;
        const db = (pts[b][0] - sx) ** 2 + (pts[b][1] - sy) ** 2;
        return da - db;
      });
      for (const j of list) {
        const nx = pts[j][0] - sx, ny = pts[j][1] - sy;
        [vx, vy, tags] = clipPoly(vx, vy, tags, sx + nx / 2, sy + ny / 2, nx, ny, j);
      }
      for (let k = 0; k < tags.length; k++) {
        const j = tags[k];
        if (j < 0) continue;
        const k2 = (k + 1) % tags.length;
        const key = i < j ? i * n + j : j * n + i;
        const len = Math.hypot(vx[k2] - vx[k], vy[k2] - vy[k]);
        if (len > d * 0.12 && !edges.has(key)) edges.set(key, [i, j, vx[k], vy[k], vx[k2], vy[k2]]);
      }
      const c = cells[i];
      c.boundary = tags.indexOf(-1) >= 0;
      if (c.boundary) {
        // round off surface cells so the outline looks like lumpy rock
        const a0 = r() * TAU;
        for (let k = 0; k < 12; k++) {
          const a = a0 + (k / 12) * TAU;
          const nx = Math.cos(a), ny = Math.sin(a);
          const reach = d * (0.82 + r() * 0.16);
          [vx, vy, tags] = clipPoly(vx, vy, tags, sx + nx * reach, sy + ny * reach, nx, ny, -1);
        }
      }
      const poly = [];
      let area = 0, ext = 0;
      for (let k = 0; k < vx.length; k++) {
        poly.push(vx[k], vy[k]);
        const k2 = (k + 1) % vx.length;
        area += vx[k] * vy[k2] - vx[k2] * vy[k];
        ext = Math.max(ext, Math.hypot(vx[k] - sx, vy[k] - sy));
      }
      c.poly = poly;
      c.area = Math.abs(area) / 2;
      c.ext = ext;
      c.mass = c.area * MAT[c.mat].density;
    }
    for (const e of edges.values()) {
      const a = cells[e[0]], b = cells[e[1]];
      // k = material strength; s = energy to cut it, proportional to the edge length,
      // so a crack costs the same per pixel whatever size the cells are
      const k = bondStrength(a, b, r);
      const len = Math.hypot(e[4] - e[2], e[5] - e[3]);
      const bond = new Bond(a, b, (k * len) / 5.5, [e[2], e[3], e[4], e[5]]);
      bond.k = k;
      a.bonds.push(bond);
      b.bonds.push(bond);
    }

    for (const c of cells) this.cells.push(c);
    ast.cells = cells;

    const body = new Body(ast);
    body.cells = cells.slice();
    for (const c of cells) c.body = body;
    const [cx, cy] = body.recompute();
    body.ox = cx; body.oy = cy;
    body.x = spec.x; body.y = spec.y;
    body.a = spec.angle || 0;
    const dx = spec.aimX - spec.x, dy = spec.aimY - spec.y, L = Math.hypot(dx, dy);
    body.vx = (dx / L) * spec.speed;
    body.vy = (dy / L) * spec.speed;
    body.w = spec.spin || 0;
    ast.body0 = body;
    this.bodies.push(body);
    this.rebuildHash();
    return body;
  };

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  World.prototype.rebuildHash = function () {
    const h = this.hash;
    h.reset(this.cells.length);
    for (const b of this.bodies) {
      if (!b.active) continue;
      const c = Math.cos(b.a), s = Math.sin(b.a);
      for (const cell of b.cells) {
        if (!cell.alive) continue;
        const lx = cell.gx - b.ox, ly = cell.gy - b.oy;
        cell.wx = b.x + c * lx - s * ly;
        cell.wy = b.y + s * lx + c * ly;
        h.insert(cell.id, cell.wx, cell.wy);
      }
    }
  };

  // Calls fn(cell) for every live cell whose site is within the grid squares covering radius r.
  World.prototype.forCells = function (x, y, r, fn) {
    const h = this.hash, cells = this.cells;
    const ix0 = Math.max(0, Math.floor((x - r - h.x0) / h.size));
    const ix1 = Math.min(h.nx - 1, Math.floor((x + r - h.x0) / h.size));
    const iy0 = Math.max(0, Math.floor((y - r - h.y0) / h.size));
    const iy1 = Math.min(h.ny - 1, Math.floor((y + r - h.y0) / h.size));
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let id = h.head[iy * h.nx + ix]; id !== -1; id = h.next[id]) {
          const c = cells[id];
          if (c.alive && c.body.active) fn(c);
        }
      }
    }
  };

  // Is there a live cell covering this point? (optionally restricted to one body)
  World.prototype.cellAt = function (x, y, body, slack) {
    const h = this.hash, cells = this.cells;
    const k = slack || 1.12;
    const ix = Math.floor((x - h.x0) / h.size), iy = Math.floor((y - h.y0) / h.size);
    for (let yy = Math.max(0, iy - 1); yy <= Math.min(h.ny - 1, iy + 1); yy++) {
      for (let xx = Math.max(0, ix - 1); xx <= Math.min(h.nx - 1, ix + 1); xx++) {
        for (let id = h.head[yy * h.nx + xx]; id !== -1; id = h.next[id]) {
          const c = cells[id];
          if (!c.alive || !c.body.active || (body && c.body !== body)) continue;
          const dx = c.wx - x, dy = c.wy - y, rr = c.r * k;
          if (dx * dx + dy * dy < rr * rr) return c;
        }
      }
    }
    return null;
  };

  World.prototype.nearestCell = function (x, y, maxR, skipCrumbs) {
    let best = null, bd = Infinity;
    this.forCells(x, y, maxR + this.maxR, (c) => {
      if (skipCrumbs && c.body.cells.length <= CRUMB) return;
      const d = Math.hypot(c.wx - x, c.wy - y) - c.r;
      if (d < bd) { bd = d; best = c; }
    });
    return best && bd <= maxR ? { cell: best, dist: bd } : null;
  };

  // Fraction of directions around a point that are blocked by rock (0 = open space, 1 = fully buried)
  World.prototype.confinement = function (x, y) {
    const N = 16, L = 30, step = 4;
    let hits = 0;
    for (let k = 0; k < N; k++) {
      const a = ((k + 0.5) / N) * TAU, cx = Math.cos(a), cy = Math.sin(a);
      for (let s = step * 0.6; s <= L; s += step) {
        if (this.cellAt(x + cx * s, y + cy * s)) { hits++; break; }
      }
    }
    return hits / N;
  };

  // First cell hit by a moving point. Crumbs (tiny debris) are collected in `crumbs`
  // instead of counting as a hit, if that array is given.
  World.prototype.sweep = function (x0, y0, x1, y1, pr, crumbs) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const half = Math.hypot(x1 - x0, y1 - y0) / 2;
    let best = null, bestT = 2;
    this.forCells(mx, my, half + pr + this.maxR, (c) => {
      const t = segParam(x0, y0, x1, y1, c.wx, c.wy);
      const qx = x0 + (x1 - x0) * t, qy = y0 + (y1 - y0) * t;
      const dx = c.wx - qx, dy = c.wy - qy, rr = c.r + pr;
      if (dx * dx + dy * dy >= rr * rr) return;
      if (crumbs && c.body.cells.length <= CRUMB) { crumbs.push(c); return; }
      if (t < bestT) { bestT = t; best = c; }
    });
    if (!best) return null;
    const qx = x0 + (x1 - x0) * bestT, qy = y0 + (y1 - y0) * bestT;
    const dx = qx - best.wx, dy = qy - best.wy, L = Math.hypot(dx, dy) || 1;
    return { cell: best, x: best.wx + (dx / L) * best.r, y: best.wy + (dy / L) * best.r };
  };

  // ---------------------------------------------------------------------------
  // Simulation step
  // ---------------------------------------------------------------------------
  World.prototype.step = function (dt) {
    this.t += dt;
    for (const b of this.bodies) {
      if (!b.active) continue;
      gravity(b.x, b.y);
      b.vx += gax * dt; b.vy += gay * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.a += b.w * dt;
      if (b.heat > 0) b.heat = Math.max(0, b.heat - dt * 0.3);
    }
    this.rebuildHash();
    this.collide();
    for (const p of this.pens) {
      if (p.state === 'wait' && this.t >= p.delay) {
        p.state = 'fly';
        this.events.push({ type: 'penLaunch', pen: p });
      }
      if (p.state === 'fly') this.stepPen(p, dt);
    }
    for (const b of this.bodies.slice()) if (b.active && b.needsSplit) this.splitBody(b);
    this.checkBodies();
    this.stepEntries(dt);
    if (this.crackGlows.length && this.t - this.crackGlows[0].t > 1.5) {
      this.crackGlows = this.crackGlows.filter((g) => this.t - g.t <= 1.5);
    }
  };

  World.prototype.collide = function () {
    const h = this.hash, cells = this.cells;
    for (const A of this.bodies) {
      if (!A.active) continue;
      for (const ci of A.cells) {
        if (!ci.alive) continue;
        const ix = Math.floor((ci.wx - h.x0) / h.size), iy = Math.floor((ci.wy - h.y0) / h.size);
        for (let yy = Math.max(0, iy - 1); yy <= Math.min(h.ny - 1, iy + 1); yy++) {
          for (let xx = Math.max(0, ix - 1); xx <= Math.min(h.nx - 1, ix + 1); xx++) {
            for (let id = h.head[yy * h.nx + xx]; id !== -1; id = h.next[id]) {
              if (id <= ci.id) continue;
              const cj = cells[id];
              const B = cj.body;
              if (B === A || !cj.alive || !B.active) continue;
              this.contact(A, ci, B, cj);
            }
          }
        }
      }
    }
  };

  World.prototype.contact = function (A, ci, B, cj) {
    const dx = cj.wx - ci.wx, dy = cj.wy - ci.wy;
    const d2 = dx * dx + dy * dy, rs = ci.r + cj.r;
    if (d2 >= rs * rs || d2 < 1e-6) return;
    const dist = Math.sqrt(d2);
    const nx = dx / dist, ny = dy / dist;
    const px = ci.wx + nx * ci.r, py = ci.wy + ny * ci.r;
    const rax = px - A.x, ray = py - A.y, rbx = px - B.x, rby = py - B.y;
    const vax = A.vx - A.w * ray, vay = A.vy + A.w * rax;
    const vbx = B.vx - B.w * rby, vby = B.vy + B.w * rbx;
    const rvx = vbx - vax, rvy = vby - vay;
    const vn = rvx * nx + rvy * ny;
    const pen = rs - dist;
    const corr = (Math.max(0, pen - 0.25) * 0.4) / (A.invM + B.invM);
    A.x -= nx * corr * A.invM; A.y -= ny * corr * A.invM;
    B.x += nx * corr * B.invM; B.y += ny * corr * B.invM;
    if (vn >= 0) return;
    const raxn = rax * ny - ray * nx, rbxn = rbx * ny - rby * nx;
    const kn = A.invM + B.invM + raxn * raxn * A.invI + rbxn * rbxn * B.invI;
    const j = (-(1 + 0.15) * vn) / kn;
    applyImpulse(A, px, py, -nx * j, -ny * j);
    applyImpulse(B, px, py, nx * j, ny * j);
    const tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty;
    const ratn = rax * ty - ray * tx, rbtn = rbx * ty - rby * tx;
    const kt = A.invM + B.invM + ratn * ratn * A.invI + rbtn * rbtn * B.invI;
    const jt = clamp(-vt / kt, -0.4 * j, 0.4 * j);
    applyImpulse(A, px, py, -tx * jt, -ty * jt);
    applyImpulse(B, px, py, tx * jt, ty * jt);
  };

  // ---------------------------------------------------------------------------
  // Penetrators
  // ---------------------------------------------------------------------------
  World.prototype.addPen = function (o) {
    const p = {
      id: o.id, kind: o.kind, x: o.x, y: o.y, vx: o.vx, vy: o.vy,
      fuse: o.fuse || 'contact', standoff: K.STANDOFF,
      delay: o.delay || 0,
      state: o.delay > 0 ? 'wait' : 'fly', health: 1, contact: false, age: 0, trail: [],
    };
    this.pens.push(p);
    return p;
  };

  World.prototype.stepPen = function (p, dt) {
    gravity(p.x, p.y);
    p.vx += gax * dt; p.vy += gay * dt;
    const x0 = p.x, y0 = p.y;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.age += dt;
    if (p.x < -150 || p.x > VIEW.w + 150 || p.y < -150 || p.y > VIEW.h + 150) {
      p.state = 'lost';
      this.events.push({ type: 'penLost', pen: p });
      return;
    }
    const dE = Math.hypot(p.x - EARTH.x, p.y - EARTH.y);
    if (dE < EARTH.atm) {
      p.state = 'lost';
      this.events.push({ type: 'penLost', pen: p });
      return;
    }
    if (p.kind === 'kinetic') {
      const crumbs = [];
      const hit = this.sweep(x0, y0, p.x, p.y, PEN_R, crumbs);
      this.punchThrough(p, crumbs);
      if (hit) this.kineticImpact(p, hit.cell, hit.x, hit.y);
    } else {
      this.stepNuke(p, x0, y0);
    }
  };

  // Penetrators smash straight through tiny debris, losing a little speed
  World.prototype.punchThrough = function (p, crumbs) {
    if (!crumbs.length) return;
    const sp = Math.hypot(p.vx, p.vy) || 1;
    for (const c of crumbs) {
      if (!c.alive) continue;
      this.pulverize(c, p.vx / sp, p.vy / sp, sp * 0.25, 'dust');
      p.vx *= 0.95;
      p.vy *= 0.95;
    }
  };

  World.prototype.kineticImpact = function (p, cell, hx, hy) {
    p.state = 'done';
    p.x = hx; p.y = hy;
    const b = cell.body;
    const d = b.ast.d;
    const rx = hx - b.x, ry = hy - b.y;
    const bvx = b.vx - b.w * ry, bvy = b.vy + b.w * rx;
    const rvx = p.vx - bvx, rvy = p.vy - bvy;
    const vrel = Math.hypot(rvx, rvy) || 1;
    const ux = rvx / vrel, uy = rvy / vrel;
    const kms = vrel * SCALE.KMS_PER_PX;
    const tons = tntTons(SCALE.IMPACTOR_KG, kms);
    const G = 60 * Math.pow(tons / 60, 0.75); // smash grows ~ speed^1.5, push ~ speed
    const mat = MAT[cell.mat];

    // 1. Momentum push, boosted by the ejecta thrown back out (beta)
    const J = Math.min(K.PUSH * mat.beta * (vrel / 450) * REF_MASS, b.mass * K.VMAX * 0.6);
    applyImpulse(b, hx, hy, ux * J, uy * J);

    // 2. Dig a crater: pulverise cells along the path until the energy runs out.
    //    Soft, porous stuff is cheap to dig but soaks up the energy.
    let budget = G * K.PEN_FRAC, eFactor = 1, x = hx, y = hy, crushed = 0, gap = 0;
    const step = 3;
    const rc0 = 6 + 4 * Math.cbrt(G / 50);
    const maxSteps = Math.ceil((b.rad * 2.4) / step);
    for (let i = 0; i < maxSteps; i++) {
      const rc = Math.max(5, rc0 * (1 - (i * step) / (rc0 * 7)));
      let any = false, stop = false;
      this.forCells(x, y, rc + this.maxR, (c) => {
        if (stop || c.body !== b) return;
        const dx = c.wx - x, dy = c.wy - y;
        if (dx * dx + dy * dy > rc * rc) return;
        any = true;
        const m = MAT[c.mat], a = c.area / REF_CELL;
        const cost = m.crush * a * K.CRUSH;
        if (budget < cost) { stop = true; return; }
        budget = (budget - cost) * (1 - m.absorb * a * 0.5);
        eFactor *= 1 - m.absorb * a * 0.4;
        this.pulverize(c, -ux + (this.rand() - 0.5) * 0.8, -uy + (this.rand() - 0.5) * 0.8, 40 + vrel * 0.18, 'ejecta');
        crushed++;
      });
      if (stop) break;
      if (any) gap = 0;
      else if ((gap += step) > U * 4) break;
      x += ux * step; y += uy * step;
    }
    const Ef = (G * (1 - K.PEN_FRAC) + budget) * eFactor;

    // 3. Shock + cracks from the bottom of the crater
    const brit = this.localBrittleness(b, x, y);
    this.shatter(b, x, y, 1.5 * Math.pow(Ef / 60, 0.6), U * (0.9 + 1.1 * Math.cbrt(Ef / 60)));
    // Rock has a breaking threshold: gentle hits mostly push, hard hits shatter
    const crackFrac = smoothstep(4, 22, Ef);
    const nCr = Ef < 10 ? 1 : 2 + Math.floor(this.rand() * 2) + (Ef > 30 ? 1 : 0);
    const per = (Ef * K.CRACK * brit * crackFrac) / nCr;
    const base = Math.atan2(uy, ux);
    for (let k = 0; k < nCr; k++) {
      const spread = nCr === 1 ? 0 : (k / (nCr - 1) - 0.5) * 2.4;
      this.crack(b, x - ux * 4, y - uy * 4, base + spread + (this.rand() - 0.5) * 0.4, per, { wiggle: 0.35, branch: 0.1 });
    }

    // 4. Small bodies can be broken right through (energy per kilogram matters!)
    const Q = Ef / (Math.max(b.mass / REF_MASS, 0.02) * this.meanStrength(b) * 100);
    const seeds = Math.round(30 * Q);
    if (seeds >= 3) this.fragmentPattern(b, x, y, seeds, b.rad * 0.8, 1.6);

    // 5. Split and fling the pieces apart
    const M = b.mass, R = b.rad;
    const kids = this.splitBody(b);
    this.kick(kids, x, y, Ef * K.KICK, M, R);

    const info = { x: hx, y: hy, ux, uy, kms, tons, beta: mat.beta, mat: cell.mat, crushed, pieces: kids.length, G };
    this.fx.impact(hx, hy, ux, uy, info);
    this.events.push(Object.assign({ type: 'impact', pen: p }, info));
  };

  World.prototype.localBrittleness = function (b, x, y) {
    let s = 0, n = 0;
    this.forCells(x, y, b.ast.d * 2, (c) => {
      if (c.body === b) { s += MAT[c.mat].brittle; n++; }
    });
    return n ? s / n : 1;
  };

  World.prototype.stepNuke = function (p, x0, y0) {
    const speed = Math.hypot(p.vx, p.vy) || 1;
    const fuse = p.fuse === 'manual' && this.manualAs ? this.manualAs : p.fuse;
    if (!p.contact && fuse === 'standoff') {
      const n = this.nearestCell(p.x, p.y, p.standoff + 2, true);
      if (n && n.dist <= p.standoff) { this.detonate(p, 'standoff'); return; }
    }
    const crumbs = [];
    const hit = this.sweep(x0, y0, p.x, p.y, PEN_R + 1, crumbs);
    this.punchThrough(p, crumbs);
    if (hit) {
      if (!p.contact) {
        p.contact = true;
        this.events.push({ type: 'nukeContact', pen: p, mat: hit.cell.mat });
        if (fuse === 'contact') { p.x = hit.x; p.y = hit.y; this.detonate(p, 'contact'); return; }
      }
      // Burrowing: soft stuff gets crushed, hard rock crushes the nuke
      const c = hit.cell, m = MAT[c.mat];
      const vf = clamp(speed / SCALE.PEN_MAX, 0, 1.4);
      p.health -= m.crush * 0.85 * (0.35 + 0.65 * vf * vf);
      this.pulverize(c, -p.vx / speed, -p.vy / speed, speed * 0.15, 'ejecta');
      const slow = 1 - 0.12 * m.density;
      p.vx *= slow; p.vy *= slow;
      if (p.health <= 0) {
        p.x = hit.x; p.y = hit.y;
        this.detonate(p, 'crushed');
        return;
      }
    }
    if (p.contact && fuse === 'deep') {
      if (p.health < 0.3 || this.confinement(p.x, p.y) >= 0.8) this.detonate(p, 'deep');
    }
  };

  // Live info for the manual-detonation meter
  World.prototype.nukeStatus = function (p) {
    const near = this.nearestCell(p.x, p.y, 220);
    const conf = near && near.dist < 30 ? this.confinement(p.x, p.y) : 0;
    let regime = 'far';
    if (near) regime = near.dist > 3 && conf < 0.3 ? 'standoff' : conf >= BURIED ? 'buried' : 'surface';
    return { dist: near ? Math.max(0, near.dist) : Infinity, conf, regime, body: near ? near.cell.body : null };
  };

  World.prototype.detonate = function (p, reason) {
    if (p.state !== 'fly') return;
    p.state = 'done';
    const x = p.x, y = p.y, Y = SCALE.NUKE_TONS;
    const conf = this.confinement(x, y);
    const near = this.nearestCell(x, y, 300);
    let regime;
    if (!near || (near.dist > 3 && conf < 0.3)) regime = 'standoff';
    else regime = conf >= BURIED ? 'buried' : 'surface';
    const coupling = regime === 'standoff' ? 0 : 0.04 + 0.96 * smoothstep(0.55, 0.95, conf);
    const blastId = ++this.blastSeq;
    let pieces = 0;
    if (regime !== 'standoff') {
      // Every chunk of rock right around the blast gets broken – not just the nearest
      // fragment (a follower nuke often goes off among the rubble of its leader's crater).
      const G = gameEnergy(Y * coupling) * (0.4 + 0.6 * coupling);
      const reach = U * 3.5;
      const targets = [];
      for (const b of this.bodies) {
        if (!b.active || Math.hypot(b.x - x, b.y - y) - b.rad > reach) continue;
        let md = Infinity;
        for (const c of b.cells) if (c.alive) md = Math.min(md, Math.hypot(c.wx - x, c.wy - y) - c.r);
        if (md <= reach) targets.push(b);
      }
      targets.sort((a, b) => b.mass - a.mass);
      for (const b of targets) {
        if (!b.active) continue;
        const kids = this.nukeFracture(b, x, y, G, coupling);
        for (const k of kids) k.blastId = blastId;
        pieces += kids.length;
      }
    }
    let pushed = 0, maxPush = 0;
    for (const b of this.bodies.slice()) {
      if (!b.active || b.blastId === blastId) continue;
      const dv = this.radiationPush(b, x, y, Y * (regime === 'standoff' ? 1 : 0.35));
      if (dv > 0.5) pushed++;
      if (dv > maxPush) maxPush = dv;
    }
    const info = { x, y, regime, coupling, reason, conf, pieces, pushed, maxPush };
    this.fx.nuke(x, y, info);
    this.events.push(Object.assign({ type: 'nuke', pen: p }, info));
  };

  World.prototype.nukeFracture = function (b, x, y, G, coupling) {
    const d = b.ast.d;
    // 1. Vaporise rock right next to the blast
    const Rv = U * (0.7 + 0.85 * Math.cbrt(G / 60));
    for (const c of b.cells) {
      if (!c.alive) continue;
      const dx = c.wx - x, dy = c.wy - y, r = Math.hypot(dx, dy) || 1;
      if (r < Rv) this.pulverize(c, dx / r, dy / r, 120 + 180 * (1 - r / Rv), 'vapor');
    }
    // 2. Shock wave shatters rock nearby
    this.shatter(b, x, y, 1.5 * Math.pow(G / 60, 0.6), U * (0.9 + 1.1 * Math.cbrt(G / 60)));
    // 3. Radial cracks
    const n = Math.round(5 + 6 * coupling);
    const per = (G * K.NUKE_CRACK) / n;
    const a0 = this.rand() * TAU;
    for (let k = 0; k < n; k++) {
      this.crack(b, x, y, a0 + (k / n) * TAU + (this.rand() - 0.5) * 0.4, per, { wiggle: 0.3, branch: 0.07 });
    }
    // 4. Whole-body break-up: the more energy per kilogram, the more pieces
    const Q = G / (Math.max(b.mass / REF_MASS, 0.05) * this.meanStrength(b) * 100);
    this.fragmentPattern(b, x, y, Math.round(22 * Q), b.rad, 1.4 + 2.2 * coupling);
    // 5. Split and blow the pieces outward
    const M = b.mass, R = b.rad;
    const kids = this.splitBody(b);
    for (const k of kids) k.heat = Math.max(k.heat, 0.6 + 0.4 * coupling);
    this.kick(kids, x, y, G * K.NUKE_KICK * (0.45 + 0.55 * coupling), M, R, 1.6);
    return kids;
  };

  World.prototype.meanStrength = function (b) {
    let str = 0, mm = 0;
    for (const c of b.cells) if (c.alive) { str += MAT[c.mat].strength * c.mass; mm += c.mass; }
    return mm > 0 ? str / mm : 1;
  };

  // Break a body into Voronoi-shaped chunks around random seed points.
  // Seeds cluster near the blast, so pieces are small close in and bigger far away.
  World.prototype.fragmentPattern = function (b, x, y, nSeeds, r0, maxK) {
    const cells = b.cells.filter((c) => c.alive);
    nSeeds = Math.min(nSeeds, Math.floor(cells.length / 2));
    if (nSeeds < 2) return;
    const wts = cells.map((c) => 1 / (1 + ((c.wx - x) ** 2 + (c.wy - y) ** 2) / (r0 * r0)));
    const tot = wts.reduce((s, v) => s + v, 0);
    const seeds = [];
    for (let k = 0; k < nSeeds; k++) {
      let t = this.rand() * tot;
      for (let i = 0; i < cells.length; i++) {
        t -= wts[i];
        if (t <= 0) { seeds.push(cells[i]); break; }
      }
    }
    for (const c of cells) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const s = seeds[k];
        const dd = (s.wx - c.wx) ** 2 + (s.wy - c.wy) ** 2;
        if (dd < bd) { bd = dd; best = k; }
      }
      c.frag = best;
    }
    for (const c of cells) {
      for (const bond of c.bonds) {
        if (bond.broken) continue;
        const o = bond.a === c ? bond.b : bond.a;
        if (!o.alive || o.body !== b || o.frag === c.frag) continue;
        if (bond.k <= maxK * (0.6 + 0.8 * this.rand())) this.breakBond(bond);
      }
    }
  };

  // X-rays heat the facing surface; the vapour blasting off pushes the body away
  World.prototype.radiationPush = function (b, x, y, Y) {
    let s = Infinity;
    for (const c of b.cells) {
      if (!c.alive) continue;
      const dd = Math.hypot(c.wx - x, c.wy - y) - c.r;
      if (dd < s) s = dd;
    }
    if (!isFinite(s)) return 0;
    s = Math.max(0, s);
    const Rb = Math.sqrt(b.area / Math.PI);
    const D = s + Rb;
    if (s > 480) return 0;
    const ratio = Math.min(1, Rb / D);
    const frac = (1 - Math.sqrt(1 - ratio * ratio)) / 2;
    const nearF = 0.3 + 0.7 * smoothstep(0, 0.4 * Rb, s);
    const Mn = b.mass / REF_MASS;
    const dv = Math.min(K.VMAX, (K.SO_PUSH * (Y / 1e5) * frac * nearF) / Math.max(Mn, 0.02));
    const dx = b.x - x, dy = b.y - y, L = Math.hypot(dx, dy) || 1;
    b.vx += (dx / L) * dv;
    b.vy += (dy / L) * dv;
    b.w += (this.rand() - 0.5) * Math.min(1.5, dv * 0.02);
    b.heat = Math.max(b.heat, Math.min(1, frac * 6));
    // vaporise a thin skin on the side facing the blast
    const nVap = Math.min(Math.floor(b.cells.length * 0.2), Math.round(frac * 40 * nearF * (Y / 1e5)));
    if (nVap > 0) {
      const facing = b.cells.filter((c) => c.alive).map((c) => [c, Math.hypot(c.wx - x, c.wy - y)]);
      facing.sort((p, q) => p[1] - q[1]);
      for (let i = 0; i < nVap && i < facing.length; i++) {
        const c = facing[i][0];
        this.pulverize(c, (x - c.wx) / facing[i][1], (y - c.wy) / facing[i][1], 90, 'vapor');
      }
    }
    if (dv > 0.5) this.fx.push(b, dx / L, dy / L, dv);
    return dv;
  };

  // ---------------------------------------------------------------------------
  // Fracture tools
  // ---------------------------------------------------------------------------
  World.prototype.pulverize = function (c, dirx, diry, speed, style) {
    if (!c.alive) return;
    c.alive = false;
    const b = c.body;
    b.dirty = true;
    b.needsSplit = true;
    this.fx.dust(c.wx, c.wy, b.vx, b.vy, dirx, diry, speed, c.mat, style || 'dust', c.area);
  };

  World.prototype.breakBond = function (bond) {
    bond.broken = true;
    const b = bond.a.body;
    b.dirty = true;
    b.needsSplit = true;
    this.crackGlows.push({ bond, t: this.t });
  };

  // Shock wave from (x,y): strength S0 fading with distance (scale r0).
  // Weak bonds (rubble, fluff) break far away; strong rock only breaks close in.
  World.prototype.shatter = function (b, x, y, S0, r0) {
    const st = ++this.stamp;
    const rMax = Math.min(b.rad * 2.2, r0 * Math.pow(Math.max(0, S0 / 0.05 - 1), 0.4));
    const visit = (c) => {
      for (const bond of c.bonds) {
        if (bond.broken || bond.stamp === st) continue;
        bond.stamp = st;
        const o = bond.a === c ? bond.b : bond.a;
        if (!o.alive || o.body !== b) continue;
        const mx = (c.wx + o.wx) / 2 - x, my = (c.wy + o.wy) / 2 - y;
        const r = Math.sqrt(mx * mx + my * my);
        if (r > rMax) continue;
        const S = S0 / (1 + Math.pow(r / r0, 2.5));
        if (S > bond.k * (0.5 + this.rand())) this.breakBond(bond);
      }
    };
    if (rMax > b.rad * 0.8) {
      for (const c of b.cells) if (c.alive) visit(c);
    } else {
      this.forCells(x, y, rMax + this.maxD, (c) => { if (c.body === b) visit(c); });
    }
  };

  // Break every bond in body b that crosses segment (x0,y0)-(x1,y1).
  // Returns energy left, or -1 if a bond was too strong (crack stops).
  World.prototype.cutSegment = function (b, x0, y0, x1, y1, energy, skipStrong) {
    const st = ++this.stamp;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const rad = Math.hypot(x1 - x0, y1 - y0) / 2 + b.ast.d * 1.4;
    const hits = [];
    this.forCells(mx, my, rad, (c) => {
      if (c.body !== b) return;
      for (const bond of c.bonds) {
        if (bond.broken || bond.stamp === st) continue;
        bond.stamp = st;
        const o = bond.a === c ? bond.b : bond.a;
        if (!o.alive || o.body !== b) continue;
        if (segIntersect(c.wx, c.wy, o.wx, o.wy, x0, y0, x1, y1)) hits.push(bond);
      }
    });
    for (const bond of hits) {
      if (energy >= bond.s) {
        this.breakBond(bond);
        energy -= bond.s;
      } else if (!skipStrong) {
        return -1;
      }
    }
    return energy;
  };

  World.prototype.cellNear = function (x, y, b, r) {
    let found = null;
    const r2 = r * r;
    this.forCells(x, y, r, (c) => {
      if (found || c.body !== b) return;
      const dx = c.wx - x, dy = c.wy - y;
      if (dx * dx + dy * dy < r2) found = c;
    });
    return found;
  };

  World.prototype.crack = function (b, sx, sy, ang, energy, opts, depth) {
    const d = b.ast.d, step = d * 0.55;
    let x = sx, y = sy, a = ang;
    const wig = opts.wiggle || 0.35;
    let outside = 0;
    for (let i = 0; i < 400 && energy > 0; i++) {
      a += (this.rand() - 0.5) * wig;
      const nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
      const c = this.cellNear(nx, ny, b, d * 0.95);
      if (!c) {
        outside += step;
        if (outside > d * 2.5) break; // left the body (or crossed a big hole)
        x = nx; y = ny;
        continue;
      }
      outside = 0;
      energy *= 1 - MAT[c.mat].absorb * 0.6;
      energy -= 0.04;
      energy = this.cutSegment(b, x, y, nx, ny, energy, false);
      if (energy < 0) break;
      x = nx; y = ny;
      if ((depth || 0) < 2 && opts.branch && energy > 3 && this.rand() < opts.branch) {
        const e2 = energy * 0.4;
        energy *= 0.6;
        this.crack(b, x, y, a + (this.rand() < 0.5 ? -1 : 1) * (0.5 + this.rand() * 0.6), e2, opts, (depth || 0) + 1);
      }
    }
  };

  World.prototype.crackRing = function (b, cx, cy, radius, energy) {
    const d = b.ast.d, step = d * 0.55;
    const n = Math.max(6, Math.ceil((TAU * radius) / step));
    let a = this.rand() * TAU;
    const da = TAU / n;
    let px = cx + Math.cos(a) * radius, py = cy + Math.sin(a) * radius;
    for (let k = 0; k < n && energy > 0; k++) {
      a += da;
      const r = radius * (1 + (this.rand() - 0.5) * 0.12);
      const nx = cx + Math.cos(a) * r, ny = cy + Math.sin(a) * r;
      if (this.cellNear(nx, ny, b, d * 0.95)) {
        energy = this.cutSegment(b, px, py, nx, ny, energy, true);
        energy *= 0.995;
      }
      px = nx; py = ny;
    }
  };

  // Find connected groups of cells and turn each into its own rigid body
  World.prototype.splitBody = function (b) {
    b.needsSplit = false;
    const alive = b.cells.filter((c) => c.alive);
    if (!alive.length) {
      b.active = false;
      b.gone = true;
      return [];
    }
    const st = ++this.stamp;
    const comps = [];
    for (const c of alive) {
      if (c.stamp === st) continue;
      const comp = [];
      const stack = [c];
      c.stamp = st;
      while (stack.length) {
        const u = stack.pop();
        comp.push(u);
        for (const bond of u.bonds) {
          if (bond.broken) continue;
          const v = bond.a === u ? bond.b : bond.a;
          if (v.stamp === st || !v.alive || v.body !== b) continue;
          v.stamp = st;
          stack.push(v);
        }
      }
      comps.push(comp);
    }
    comps.sort((p, q) => q.length - p.length);
    const c0 = Math.cos(b.a), s0 = Math.sin(b.a);
    const P = { x: b.x, y: b.y, ox: b.ox, oy: b.oy, vx: b.vx, vy: b.vy, w: b.w, a: b.a };
    const out = [];
    for (let i = 0; i < comps.length; i++) {
      const nb = i === 0 ? b : new Body(b.ast);
      nb.cells = comps[i];
      for (const c of nb.cells) c.body = nb;
      const [cx, cy] = nb.recompute();
      const dx = cx - P.ox, dy = cy - P.oy;
      const wx = c0 * dx - s0 * dy, wy = s0 * dx + c0 * dy;
      nb.ox = cx; nb.oy = cy;
      nb.x = P.x + wx; nb.y = P.y + wy; nb.a = P.a;
      nb.vx = P.vx - P.w * wy; nb.vy = P.vy + P.w * wx; nb.w = P.w;
      nb.heat = b.heat;
      nb.dirty = true;
      nb.active = true;
      if (i > 0) this.bodies.push(nb);
      out.push(nb);
    }
    return out;
  };

  // Spread fragments outward from (qx,qy) using energy E, conserving momentum
  World.prototype.kick = function (kids, qx, qy, E, M, R, reach) {
    if (kids.length < 2 || E <= 0) return;
    const Mn = M / REF_MASS;
    const base = K.KICK_V * Math.sqrt(E / Math.max(Mn, 0.05));
    const kv = [];
    let px = 0, py = 0, mt = 0;
    for (const k of kids) {
      let dx = k.x - qx, dy = k.y - qy;
      let r = Math.hypot(dx, dy);
      if (r < 0.5) {
        const a = this.rand() * TAU;
        dx = Math.cos(a); dy = Math.sin(a); r = 1;
      }
      const f = 1 / (1 + r / (R * (reach || 0.9)));
      const s = Math.min(K.VMAX, base * f * Math.pow(k.mass / M, -1 / 6) * (0.75 + 0.5 * this.rand()));
      const vx = (dx / r) * s, vy = (dy / r) * s;
      kv.push(vx, vy);
      px += vx * k.mass; py += vy * k.mass; mt += k.mass;
    }
    px /= mt; py /= mt;
    kids.forEach((k, i) => {
      k.vx += kv[2 * i] - px;
      k.vy += kv[2 * i + 1] - py;
      const sp = Math.hypot(kv[2 * i], kv[2 * i + 1]);
      k.w += (this.rand() - 0.5) * Math.min(3, sp / (k.rad + 6));
    });
  };

  // ---------------------------------------------------------------------------
  // Atmosphere entry and leaving the screen
  // ---------------------------------------------------------------------------
  World.prototype.checkBodies = function () {
    let removed = false;
    for (const b of this.bodies) {
      if (!b.active) { removed = true; continue; }
      const dist = Math.hypot(b.x - EARTH.x, b.y - EARTH.y);
      if (dist - b.rad < EARTH.atm) {
        let inside = false;
        for (const c of b.cells) {
          if (c.alive && Math.hypot(c.wx - EARTH.x, c.wy - EARTH.y) < EARTH.atm) { inside = true; break; }
        }
        if (inside) { this.beginEntry(b); removed = true; continue; }
      }
      if (b.x < -120 || b.x > VIEW.w + 220 || b.y < -160 || b.y > VIEW.h + 160) {
        b.active = false;
        removed = true;
        this.events.push({ type: 'miss', sizeM: b.sizeM(), effM: b.effM(), x: b.x, y: b.y, body: b });
      }
    }
    if (removed) this.bodies = this.bodies.filter((b) => b.active);
  };

  World.prototype.beginEntry = function (b) {
    b.active = false;
    b.entering = true;
    const sizeM = b.sizeM(), effM = sizeM * b.entryFactor();
    const outcome = ED.classifyEntry(effM);
    const endFrac =
      outcome === 'burn' ? 0.22 + 0.3 * Math.min(1, effM / 15)
      : outcome === 'small' ? 0.55 + 0.1 * this.rand()
      : outcome === 'big' ? 0.78 + 0.08 * this.rand()
      : 1.0;
    const e = { body: b, t: 0, outcome, sizeM, effM, endFrac, frac: 0, scale: 1, done: false };
    this.entries.push(e);
    this.events.push({ type: 'entryStart', outcome, sizeM, effM, x: b.x, y: b.y, body: b });
  };

  World.prototype.stepEntries = function (dt) {
    if (!this.entries.length) return;
    for (const e of this.entries) {
      const b = e.body;
      e.t += dt;
      const dx = b.x - EARTH.x, dy = b.y - EARTH.y, dist = Math.hypot(dx, dy) || 1;
      const alt = dist - EARTH.R;
      e.frac = clamp(1 - alt / (EARTH.atm - EARTH.R), 0, 1);
      b.vx -= (dx / dist) * 160 * dt;
      b.vy -= (dy / dist) * 160 * dt;
      const drag = Math.exp(-dt * (0.4 + 1.4 / (1 + e.effM / 20)));
      b.vx *= drag; b.vy *= drag;
      b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.w * dt;
      const shrink = e.outcome === 'ground' ? 0.25 : 0.85;
      e.scale = 1 - shrink * Math.min(1, e.frac / e.endFrac);
      b.heat = Math.min(1, 0.45 + e.frac * 1.2);
      if (e.frac >= e.endFrac || e.t > 5) {
        e.done = true;
        const damage = ED.entryDamage(e.outcome, e.effM);
        const ang = Math.atan2(dy, dx);
        this.events.push({ type: 'outcome', outcome: e.outcome, x: b.x, y: b.y, ang, sizeM: e.sizeM, effM: e.effM, damage, body: b });
      }
    }
    this.entries = this.entries.filter((e) => !e.done);
  };

  World.prototype.isResolved = function () {
    return this.bodies.length === 0 && this.entries.length === 0 && !this.pens.some((p) => p.state === 'fly' || p.state === 'wait');
  };

  // Closest distance between Earth's centre and this body's straight-line path
  World.prototype.closestApproach = function (b) {
    const dx = EARTH.x - b.x, dy = EARTH.y - b.y;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < 1e-6) return null;
    const t = (dx * b.vx + dy * b.vy) / v2;
    if (t <= 0) return null;
    const cx = b.x + b.vx * t, cy = b.y + b.vy * t;
    return { dist: Math.hypot(cx - EARTH.x, cy - EARTH.y), x: cx, y: cy, t };
  };

  // Does this body's current straight-line path cross the atmosphere?
  World.prototype.headingForEarth = function (b) {
    const dx = EARTH.x - b.x, dy = EARTH.y - b.y;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < 1e-6) return null;
    const t = (dx * b.vx + dy * b.vy) / v2;
    if (t <= 0) return null;
    const cx = b.x + b.vx * t - EARTH.x, cy = b.y + b.vy * t - EARTH.y;
    const miss = Math.hypot(cx, cy);
    if (miss > EARTH.atm + b.rad * 0.5) return null;
    // entry point
    const back = Math.sqrt(Math.max(0, EARTH.atm * EARTH.atm - miss * miss)) / Math.sqrt(v2);
    const te = Math.max(0, t - back);
    return { x: b.x + b.vx * te, y: b.y + b.vy * te, t: te };
  };

  // ---------------------------------------------------------------------------
  // Predictor: ballistic preview of where each penetrator will hit
  // ---------------------------------------------------------------------------
  const PDT = 1 / 120;
  function Predictor(world, seconds) {
    this.world = world;
    this.N = Math.round((seconds || 9) / PDT);
    this.targets = world.bodies.map((b) => this.prepare(b));
  }
  Predictor.prototype.prepare = function (b) {
    const d = b.ast.d;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of b.cells) {
      minX = Math.min(minX, c.gx); minY = Math.min(minY, c.gy);
      maxX = Math.max(maxX, c.gx); maxY = Math.max(maxY, c.gy);
    }
    const gs = d;
    const nx = Math.ceil((maxX - minX) / gs) + 3, ny = Math.ceil((maxY - minY) / gs) + 3;
    const grid = Array.from({ length: nx * ny }, () => []);
    const x0 = minX - gs, y0 = minY - gs;
    for (const c of b.cells) {
      if (!c.alive) continue;
      grid[Math.floor((c.gy - y0) / gs) * nx + Math.floor((c.gx - x0) / gs)].push(c);
    }
    // pose track
    const px = new Float32Array(this.N + 1), py = new Float32Array(this.N + 1), pa = new Float32Array(this.N + 1);
    let x = b.x, y = b.y, a = b.a, vx = b.vx, vy = b.vy;
    let impactStep = -1;
    for (let i = 0; i <= this.N; i++) {
      px[i] = x; py[i] = y; pa[i] = a;
      if (impactStep < 0 && Math.hypot(x - EARTH.x, y - EARTH.y) - b.rad * 0.7 < EARTH.atm) impactStep = i;
      gravity(x, y);
      vx += gax * PDT; vy += gay * PDT;
      x += vx * PDT; y += vy * PDT; a += b.w * PDT;
    }
    return { body: b, grid, gs, nx, ny, x0, y0, px, py, pa, impactStep };
  };
  // distance from a world point to the nearest cell surface of target T at step i
  Predictor.prototype.probe = function (T, i, wx, wy, reach) {
    const c = Math.cos(T.pa[i]), s = Math.sin(T.pa[i]);
    const dx = wx - T.px[i], dy = wy - T.py[i];
    const gx = c * dx + s * dy + T.body.ox, gy = -s * dx + c * dy + T.body.oy;
    const ix = Math.floor((gx - T.x0) / T.gs), iy = Math.floor((gy - T.y0) / T.gs);
    const span = Math.ceil(reach / T.gs) + 1;
    let best = Infinity;
    for (let yy = Math.max(0, iy - span); yy <= Math.min(T.ny - 1, iy + span); yy++) {
      for (let xx = Math.max(0, ix - span); xx <= Math.min(T.nx - 1, ix + span); xx++) {
        const list = T.grid[yy * T.nx + xx];
        for (let k = 0; k < list.length; k++) {
          const cell = list[k];
          const dd = Math.hypot(cell.gx - gx, cell.gy - gy) - cell.r;
          if (dd < best) best = dd;
        }
      }
    }
    return { dist: best, gx, gy };
  };
  Predictor.prototype.predict = function (pen) {
    let x = pen.x, y = pen.y, vx = pen.vx, vy = pen.vy;
    const path = [x, y];
    const reach = pen.kind === 'nuke' && pen.fuse === 'standoff' ? K.STANDOFF : 0;
    const i0 = Math.round((pen.delay || 0) / PDT);
    for (let i = i0 + 1; i <= this.N; i++) {
      gravity(x, y);
      vx += gax * PDT; vy += gay * PDT;
      const sx = x, sy = y;
      x += vx * PDT; y += vy * PDT;
      if (i % 3 === 0) path.push(x, y);
      if (x < -150 || x > VIEW.w + 150 || y < -150 || y > VIEW.h + 150 || Math.hypot(x - EARTH.x, y - EARTH.y) < EARTH.atm) {
        path.push(x, y);
        return { hit: false, path, t: i * PDT };
      }
      for (let k = 0; k < this.targets.length; k++) {
        const T = this.targets[k];
        if (Math.hypot(x - T.px[i], y - T.py[i]) > T.body.rad + reach + 12) continue;
        for (let h = 1; h <= 2; h++) {
          const qx = sx + ((x - sx) * h) / 2, qy = sy + ((y - sy) * h) / 2;
          const pr = this.probe(T, i, qx, qy, reach + PEN_R + 2);
          if (pr.dist <= reach + PEN_R) {
            path.push(qx, qy);
            return { hit: true, t: i * PDT, step: i, x: qx, y: qy, gx: pr.gx, gy: pr.gy, target: k, path, standoff: reach > 0 };
          }
        }
      }
    }
    return { hit: false, path, t: this.N * PDT };
  };
  // Choose a direction (keeping speed) so the penetrator hits generation-frame point (gx,gy) of target k
  Predictor.prototype.aimAt = function (pen, k, gx, gy) {
    const T = this.targets[k];
    const N = this.N;
    solveAim(pen, (t) => {
      const i = Math.min(N, Math.max(0, Math.round(t / PDT)));
      const c = Math.cos(T.pa[i]), s = Math.sin(T.pa[i]);
      const lx = gx - T.body.ox, ly = gy - T.body.oy;
      return [T.px[i] + c * lx - s * ly, T.py[i] + s * lx + c * ly];
    }, N * PDT);
  };

  // Turn the penetrator (keeping its speed and launch delay) so its path meets a moving
  // target. track(t) gives the target's position at time t, or null if it is gone.
  function solveAim(pen, track, tMax) {
    const speed = Math.hypot(pen.vx, pen.vy) || SCALE.PEN_MAX;
    const delay = pen.delay || 0;
    let P = track(delay);
    if (!P) return false;
    // first guess: lead the target by the straight-line flight time
    for (let k = 0; k < 3; k++) {
      const f = Math.hypot(P[0] - pen.x, P[1] - pen.y) / speed;
      const Q = track(Math.min(tMax, delay + f));
      if (Q) P = Q;
    }
    let ang = Math.atan2(P[1] - pen.y, P[0] - pen.x);
    for (let iter = 0; iter < 14; iter++) {
      let x = pen.x, y = pen.y, vx = Math.cos(ang) * speed, vy = Math.sin(ang) * speed;
      let best = Infinity, bt = 0, bmx = 0, bmy = 0;
      for (let t = delay + PDT; t <= tMax; t += PDT) {
        gravity(x, y);
        vx += gax * PDT; vy += gay * PDT;
        x += vx * PDT; y += vy * PDT;
        const Q = track(t);
        if (!Q) continue;
        const dd = Math.hypot(Q[0] - x, Q[1] - y);
        if (dd < best) { best = dd; bt = t; bmx = Q[0] - x; bmy = Q[1] - y; }
        else if (dd > best + 80) break;
      }
      if (!isFinite(best) || best < 0.5) break;
      const dirx = Math.cos(ang), diry = Math.sin(ang);
      const perp = -diry * bmx + dirx * bmy;
      const range = Math.max(20, speed * (bt - delay));
      ang += Math.atan2(perp, range);
    }
    pen.vx = Math.cos(ang) * speed;
    pen.vy = Math.sin(ang) * speed;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Recorder: the "mission computer". Runs the real (deterministic) simulation of a
  // plan in the background and records where every rock cell is, 30 times a second,
  // so the planner can show a hologram of future debris and aim at fragments.
  // ---------------------------------------------------------------------------
  const REC_EVERY = 8; // physics steps per recorded frame
  const FPS = 1 / (DT * REC_EVERY); // 30 frames per second
  const GS = 14; // grid size for frame lookups
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function Recorder(specs, pens, tEnd) {
    const w = new World(4242);
    for (const a of specs) w.addAsteroid(a);
    w.manualAs = 'contact';
    for (const p of pens) w.addPen(Object.assign({}, p));
    this.w = w;
    this.n = w.cells.length;
    this.np = w.pens.length;
    this.r = new Float32Array(this.n);
    w.cells.forEach((c, i) => (this.r[i] = c.r));
    this.frames = [];
    this.sizes = [];
    this.penFrames = [];
    this.impacts = [];
    this.tEnd = tEnd;
    this.lastEventT = 0;
    this.done = false;
    this.grids = new Map();
    this.capture();
  }
  Recorder.prototype.capture = function () {
    const f = new Float32Array(2 * this.n).fill(NaN);
    for (const b of this.w.bodies) {
      if (!b.active) continue;
      const c = Math.cos(b.a), s = Math.sin(b.a);
      for (const cell of b.cells) {
        if (!cell.alive) continue;
        const lx = cell.gx - b.ox, ly = cell.gy - b.oy;
        f[2 * cell.id] = b.x + c * lx - s * ly;
        f[2 * cell.id + 1] = b.y + s * lx + c * ly;
      }
    }
    this.frames.push(f);
    const sz = new Uint8Array(this.n);
    for (const b of this.w.bodies) {
      if (!b.active) continue;
      const k = Math.min(255, b.cells.length);
      for (const cell of b.cells) sz[cell.id] = k;
    }
    this.sizes.push(sz);
    const pf = new Float32Array(3 * this.np);
    this.w.pens.forEach((p, i) => {
      pf[3 * i] = p.x;
      pf[3 * i + 1] = p.y;
      pf[3 * i + 2] = p.state === 'wait' ? 0 : p.state === 'fly' ? 1 : 2;
    });
    this.penFrames.push(pf);
  };
  // Advance the recording for up to budgetMs milliseconds. Returns true when finished.
  Recorder.prototype.run = function (budgetMs) {
    const t0 = now();
    const w = this.w;
    while (!this.done && now() - t0 < budgetMs) {
      for (let k = 0; k < REC_EVERY; k++) {
        w.step(DT);
        for (const e of w.events) {
          if (e.type === 'impact' || e.type === 'nuke') {
            this.impacts.push({ t: w.t, x: e.x, y: e.y, kind: e.type, regime: e.regime, id: e.pen.id });
            this.lastEventT = w.t;
          }
        }
        w.events.length = 0;
      }
      this.capture();
      const pending = w.pens.some((p) => p.state === 'fly' || p.state === 'wait');
      if (w.t >= this.tEnd || w.bodies.length === 0 || (!pending && w.t > this.lastEventT + 2.5)) this.done = true;
    }
    return this.done;
  };
  Recorder.prototype.progress = function () {
    return Math.min(1, this.w.t / this.tEnd);
  };
  Recorder.prototype.duration = function () {
    return (this.frames.length - 1) / FPS;
  };
  Recorder.prototype.frameAt = function (t) {
    const fi = Math.max(0, t * FPS);
    let k = Math.floor(fi);
    if (k >= this.frames.length - 1) return [Math.max(0, this.frames.length - 2), 1];
    return [k, fi - k];
  };
  Recorder.prototype.cellPos = function (id, t) {
    if (this.frames.length < 2) return null;
    const [k, u] = this.frameAt(t);
    const A = this.frames[k], B = this.frames[k + 1];
    const ax = A[2 * id];
    if (ax !== ax) return null; // NaN: gone
    let bx = B[2 * id], by = B[2 * id + 1];
    if (bx !== bx) { bx = ax; by = A[2 * id + 1]; }
    return [ax + (bx - ax) * u, A[2 * id + 1] + (by - A[2 * id + 1]) * u];
  };
  Recorder.prototype.grid = function (k) {
    let g = this.grids.get(k);
    if (g) return g;
    g = new Map();
    const f = this.frames[k];
    for (let id = 0; id < this.n; id++) {
      const x = f[2 * id];
      if (x !== x) continue;
      const key = Math.floor((x + 2000) / GS) * 8192 + Math.floor((f[2 * id + 1] + 2000) / GS);
      let list = g.get(key);
      if (!list) g.set(key, (list = []));
      list.push(id);
    }
    this.grids.set(k, g);
    return g;
  };
  // id of a recorded cell within `reach` of (x,y) at time t, or -1
  Recorder.prototype.probe = function (x, y, t, reach) {
    if (this.frames.length < 2) return -1;
    const [k, u] = this.frameAt(t);
    const A = this.frames[k], B = this.frames[k + 1];
    const g = this.grid(k);
    const sz = this.sizes[k];
    const ix = Math.floor((x + 2000) / GS), iy = Math.floor((y + 2000) / GS);
    const span = 1 + Math.ceil(reach / GS);
    let best = -1, bd = Infinity;
    for (let xx = ix - span; xx <= ix + span; xx++) {
      for (let yy = iy - span; yy <= iy + span; yy++) {
        const list = g.get(xx * 8192 + yy);
        if (!list) continue;
        for (const id of list) {
          if (sz[id] <= CRUMB) continue;
          const ax = A[2 * id], ay = A[2 * id + 1];
          let bx = B[2 * id], by = B[2 * id + 1];
          if (bx !== bx) { bx = ax; by = ay; }
          const d = Math.hypot(ax + (bx - ax) * u - x, ay + (by - ay) * u - y) - this.r[id];
          if (d <= reach && d < bd) { bd = d; best = id; }
        }
      }
    }
    return best;
  };
  // Flight path of a penetrator through the recorded debris
  Recorder.prototype.predict = function (pen) {
    let x = pen.x, y = pen.y, vx = pen.vx, vy = pen.vy;
    const path = [x, y];
    const reach = pen.kind === 'nuke' && pen.fuse === 'standoff' ? K.STANDOFF : 0;
    const tMax = this.duration();
    let i = 0;
    for (let t = (pen.delay || 0) + PDT; t <= tMax; t += PDT) {
      gravity(x, y);
      vx += gax * PDT; vy += gay * PDT;
      x += vx * PDT; y += vy * PDT;
      if (++i % 3 === 0) path.push(x, y);
      if (x < -150 || x > VIEW.w + 150 || y < -150 || y > VIEW.h + 150 || Math.hypot(x - EARTH.x, y - EARTH.y) < EARTH.atm) {
        path.push(x, y);
        return { hit: false, path, t };
      }
      const id = this.probe(x, y, t, reach + PEN_R);
      if (id >= 0) {
        path.push(x, y);
        return { hit: true, t, x, y, cell: id, path, standoff: reach > 0, rec: true };
      }
    }
    return { hit: false, path, t: tMax, unknown: true };
  };
  // Aim at recorded cell `id`. If T is given, also choose the launch delay so the
  // penetrator arrives at about time T.
  Recorder.prototype.aimAtCell = function (pen, id, T) {
    const track = (t) => this.cellPos(id, t);
    if (T != null) {
      const P = track(T);
      if (!P) return false;
      const speed = Math.hypot(pen.vx, pen.vy) || SCALE.PEN_MAX;
      const f = Math.hypot(P[0] - pen.x, P[1] - pen.y) / speed;
      pen.delay = Math.round(clamp(T - f, 0, SCALE.MAX_DELAY) * 20) / 20;
    }
    return solveAim(pen, track, this.duration());
  };
  Recorder.prototype.nearestCell = function (x, y, t, maxD) {
    let best = -1, bd = maxD;
    const sz = this.sizes[this.frameAt(t)[0]];
    for (let id = 0; id < this.n; id++) {
      if (sz[id] <= CRUMB) continue;
      const P = this.cellPos(id, t);
      if (!P) continue;
      const d = Math.hypot(P[0] - x, P[1] - y);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };

  ED.World = World;
  ED.Predictor = Predictor;
  ED.Recorder = Recorder;
  ED.PHYS = { DT, K, REF_MASS, REF_CELL, PEN_R, REC_FPS: FPS, tntTons, gameEnergy, gravity: (x, y) => { gravity(x, y); return [gax, gay]; } };
})();
