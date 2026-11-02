// Earth Defence – game controller: menus, planning the swarm, running the simulation, results.
(function () {
  const ED = window.ED;
  const { clamp, store, fmtNum } = ED.util;
  const S = ED.SCALE, E = ED.EARTH, ZONE = ED.ZONE, VIEW = ED.VIEW;
  const DT = ED.PHYS.DT;
  const AIM_K = 0.3; // the aim arrow shows 0.3 s of flight
  const MAX_SWARM = 10;

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const R = new ED.Renderer(canvas);
  const fx = new ED.FX();
  const audio = ED.Audio;

  const save = Object.assign({ stars: {}, facts: [], unlockAll: false }, store.get('earthdefence.v1', {}) || {});
  const persist = () => store.set('earthdefence.v1', save);
  if (!save.v2) {
    const old = save.stars || {};
    const stars = {};
    for (const k in old) {
      const id = /^\d+$/.test(k) ? ED.OLD_LEVEL_ORDER[+k] : k;
      if (id) stars[id] = Math.max(stars[id] || 0, old[k]);
    }
    save.stars = stars;
    save.v2 = true;
    persist();
  }
  const starsOf = (i) => (ED.LEVELS[i] ? save.stars[ED.LEVELS[i].id] || 0 : 0);

  const G = {
    mode: 'menu',
    levelIdx: 0,
    level: null,
    world: null,
    pred: null,
    preds: [],
    predDirty: true,
    pens: [],
    nextId: 1,
    sel: null,
    armed: null,
    drag: null,
    hover: null,
    speed: 1,
    acc: 0,
    hitStop: 0,
    slowmo: false,
    armedNuke: null,
    stats: null,
    endTimer: 0,
    lastAction: 0,
    autoFast: false,
    tut: -1,
    t: 0,
    demo: null,
    sandboxCfg: { type: 'solid', size: 'medium', path: 'middle', speed: 'normal', kinetic: 6, nuke: 2, seed: 7 },
    rec: null, // mission computer: recording in progress
    recReady: null, // latest finished recording
    recStale: false,
    recStaleT: 0,
    tlT: 0, // preview time on the mission computer timeline
    tlPlay: false,
    tlFollow: false,
    tlOpen: false,
  };

  // ---------------------------------------------------------------------------
  // Touch screens (iPad): bigger controls and "tap" wording
  // ---------------------------------------------------------------------------
  const touchUI = { on: false };
  function setTouch(on) {
    if (touchUI.on === on) return;
    touchUI.on = on;
    document.documentElement.classList.toggle('touch', on);
    if (G.mode === 'design') { renderPanel(); updateTutorial(); }
  }
  const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  if (mq('(any-pointer: coarse)') && !mq('(pointer: fine)')) setTouch(true);
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setTouch(true);
    else if (e.pointerType === 'mouse') setTouch(false);
  }, true);
  const tap = (cap) => (touchUI.on ? (cap ? 'Tap' : 'tap') : cap ? 'Click' : 'click');

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const kms = (pxs) => pxs * S.KMS_PER_PX;
  const fmtTons = (t) => (t >= 1e6 ? (t / 1e6).toFixed(1) + ' million t' : t >= 1000 ? fmtNum(t) + ' t' : Math.round(t) + ' t');
  const used = (kind) => G.pens.filter((p) => p.kind === kind).length;
  const left = (kind) => (G.level ? G.level.inventory[kind] - used(kind) : 0);
  const inZone = (x, y) => x >= ZONE.x0 && x <= ZONE.x1 && y >= ZONE.y0 && y <= ZONE.y1;
  const penLabel = (p) => String(G.pens.indexOf(p) + 1);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function effM(b) {
    if (b._effN !== b.cells.length) {
      b._effN = b.cells.length;
      b._sizeM = b.sizeM();
      b._effM = b._sizeM * b.entryFactor();
    }
    return b._effM;
  }

  function levelFromIndex(i) {
    const L = ED.LEVELS[i];
    return Object.assign({ num: i + 1, idx: i }, L);
  }

  function levelUnlocked(i) {
    return save.unlockAll || i === 0 || starsOf(i - 1) >= 1 || ED.LEVELS[i].id in save.stars;
  }

  // ---------------------------------------------------------------------------
  // Science facts
  // ---------------------------------------------------------------------------
  const toastQ = [];
  let toastBusy = false;
  function unlock(id, quiet) {
    if (!ED.FACTS[id] || save.facts.includes(id)) return false;
    save.facts.push(id);
    persist();
    if (!quiet) {
      const f = ED.FACTS[id];
      toast(`<span class="t-ico">${f.icon}</span><span><b>New logbook entry!</b><br>${esc(f.title)}</span>`, { fact: id });
    }
    updateBookBadge();
    return true;
  }
  function toast(html, opts) {
    toastQ.push({ html, opts: opts || {} });
    pumpToasts();
  }
  function pumpToasts() {
    if (toastBusy || !toastQ.length) return;
    toastBusy = true;
    const { html, opts } = toastQ.shift();
    const el = document.createElement('div');
    el.className = 'toast' + (opts.fact ? ' fact' : '');
    el.innerHTML = html;
    if (opts.fact) {
      el.title = 'Open the science logbook';
      el.addEventListener('click', () => showBook(opts.fact));
      audio.play('fact');
    }
    $('toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
      toastBusy = false;
      pumpToasts();
    }, opts.fact ? 3600 : 2600);
  }
  function updateBookBadge() {
    $('btn-book').dataset.count = save.facts.length;
  }

  // ---------------------------------------------------------------------------
  // World setup
  // ---------------------------------------------------------------------------
  function buildWorld() {
    const w = new ED.World(4242);
    for (const a of G.level.asteroids) w.addAsteroid(a);
    w.fx = fx.hooks();
    G.world = w;
    G.pred = new ED.Predictor(w, 16);
    G.rec = null;
    G.recReady = null;
    G.tlT = 0;
    G.tlPlay = false;
    G.tlOpen = false;
    planChanged();
  }

  function startLevel(level, keepPens) {
    G.level = level;
    fx.reset();
    buildWorld();
    if (!keepPens) {
      G.pens = [];
      G.nextId = 1;
    }
    G.sel = null;
    G.armed = null;
    G.drag = null;
    G.mode = 'design';
    G.tut = level.tutorial && !keepPens && !G.pens.length ? 0 : -1;
    closeModal();
    updateUI();
    if (G.tut < 0 && level.tip && !keepPens) showHint('💡 ' + level.tip, 9000);
    else if (G.tut >= 0) updateTutorial();
  }

  // ---------------------------------------------------------------------------
  // Planning: placing and aiming penetrators
  // ---------------------------------------------------------------------------
  function nearestTarget(x, y) {
    let best = 0, bd = Infinity;
    G.pred.targets.forEach((T, k) => {
      const d = Math.hypot(T.body.x - x, T.body.y - y);
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  function aimAtCentre(p) {
    const k = nearestTarget(p.x, p.y);
    const b = G.pred.targets[k].body;
    G.pred.aimAt(p, k, b.ox, b.oy);
  }

  function placePen(kind, x, y) {
    if (left(kind) <= 0) {
      toast(kind === 'nuke' ? 'No nuclear penetrators left!' : 'No kinetic impactors left!');
      return null;
    }
    const p = { id: G.nextId++, kind, x, y, vx: S.PEN_MAX * 0.95, vy: 0, delay: 0, fuse: G.level.defaultFuse || 'manual' };
    aimAtCentre(p);
    G.pens.push(p);
    select(p);
    planChanged();
    audio.play('place');
    if (left(kind) <= 0) G.armed = null;
    if (G.tut === 1) G.tut = 2;
    updateUI();
    return p;
  }

  function addFollower(lead, kind) {
    if (left(kind) <= 0) {
      toast('None of those left!');
      return;
    }
    const sp = Math.hypot(lead.vx, lead.vy) || 1;
    // walk back along the line of flight until we find a free spot
    for (let gap = 24; gap < 90; gap += 6) {
      const x = lead.x - (lead.vx / sp) * gap, y = lead.y - (lead.vy / sp) * gap;
      if (!inZone(x, y)) break;
      if (G.pens.some((q) => Math.hypot(q.x - x, q.y - y) < 18)) continue;
      const p = { id: G.nextId++, kind, x, y, vx: lead.vx, vy: lead.vy, delay: lead.delay || 0, fuse: kind === 'nuke' ? (lead.kind === 'kinetic' ? 'deep' : lead.fuse) : 'contact' };
      G.pens.push(p);
      select(p);
      planChanged();
      audio.play('place');
      updateUI();
      return;
    }
    toast('No room behind it – move the leader forward first!');
  }

  function removePen(p) {
    G.pens = G.pens.filter((q) => q !== p);
    if (G.sel === p) G.sel = null;
    planChanged();
    audio.play('remove');
    updateUI();
  }

  function planChanged() {
    G.predDirty = true;
    G.recStale = true;
    G.recStaleT = G.t;
  }

  function select(p) {
    if (p !== G.sel) closeFuseMenu();
    G.sel = p;
    if (p) audio.play('select');
    G.tlFollow = !!(p && p.delay > 0);
    if (G.tlFollow) G.tlOpen = true;
    if (p && G.tut < 0 && !tipShown) {
      tipShown = true;
      showHint(`💡 ${tap(1)} a spot on the asteroid to aim there, or drag the white handle. Its controls are in the bar at the bottom.`, 4500);
    }
    followTimeline();
    renderPanel();
  }

  function followTimeline() {
    if (!G.tlFollow || !G.sel || !G.recReady) return;
    const pr = G.preds[G.pens.indexOf(G.sel)];
    if (pr && pr.viaRec) G.tlT = Math.min(G.recReady.duration(), pr.hit ? pr.t : G.sel.delay + 1);
  }

  function refreshPredictions() {
    if (!G.predDirty || !G.pred) return;
    G.preds = G.pens.map((p) => {
      if (p.delay > 0 && G.recReady) {
        const r = G.recReady.predict(p);
        r.viaRec = true;
        return r;
      }
      const r = G.pred.predict(p);
      if (p.delay > 0) r.approx = true;
      return r;
    });
    G.predDirty = false;
    followTimeline();
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Launch and run
  // ---------------------------------------------------------------------------
  function launch() {
    if (G.mode !== 'design') return;
    if (!G.pens.length) {
      toast('Place at least one penetrator in the green zone first!');
      return;
    }
    audio.play('launch');
    G.sel = null;
    G.armed = null;
    G.drag = null;
    G.world.pens = [];
    G.pens.forEach((p, i) => {
      const wp = G.world.addPen(p);
      wp.label = String(i + 1);
    });
    G.mode = 'run';
    G.stats = { burn: 0, small: 0, big: 0, ground: 0, miss: 0, damage: 0, largest: 0, largestMiss: 0, hits: 0, nukes: 0 };
    G.acc = 0;
    G.speed = 1;
    G.endTimer = 0;
    G.lastAction = 0;
    G.autoFast = false;
    G.slowmo = false;
    hideHint();
    if (G.level.tutorial && !save.facts.includes('shooting_stars')) showHint('👀 Watch the pieces! Small ones burn up ✨. Big ones are dangerous 💥', 7000);
    updateUI();
  }

  function manualNukes() {
    return G.world.pens.filter((p) => p.state === 'fly' && p.kind === 'nuke' && p.fuse === 'manual');
  }

  function detonateNow() {
    if (G.mode !== 'run' || !G.armedNuke) return;
    G.world.detonate(G.armedNuke, 'manual');
  }

  function handleEvents() {
    const w = G.world;
    for (const e of w.events) {
      switch (e.type) {
        case 'impact':
          audio.play('impact');
          G.hitStop = 0.16;
          G.lastAction = w.t;
          G.stats.hits++;
          fx.text(e.x, e.y - 24, '💥 ' + fmtTons(e.tons) + ' of TNT', '#ffffff', 15, 1.6, 'tnt');
          if (e.beta >= 3) {
            fx.text(e.x, e.y - 44, 'Ejecta boost! β ≈ ' + e.beta.toFixed(1), '#ffd9a0', 13, 1.8, 'beta');
            unlock('ejecta');
          }
          if (e.mat === 'fluff' && !G.stats.fluffMsg) {
            G.stats.fluffMsg = true;
            fx.text(e.x, e.y + 26, '☁️ The fluff soaked it up!', '#e8d9bd', 14, 2.2);
          }
          unlock('ke');
          break;
        case 'nuke': {
          audio.play('nuke');
          G.hitStop = 0.5;
          G.lastAction = w.t;
          G.stats.nukes++;
          unlock('nuke_space');
          const pct = Math.round(e.coupling * 100);
          if (e.reason === 'crushed') {
            fx.text(e.x, e.y - 64, '🥫 Crushed by hard rock – backup fuse fired!', '#ffb0b0', 14, 2.6);
            unlock('crushed');
          }
          if (e.regime === 'standoff') {
            fx.text(e.x, e.y - 40, '📡 STANDOFF BURST – PUSH!', '#9fd2ff', 20, 2.4);
            unlock('standoff');
          } else if (e.regime === 'surface') {
            fx.text(e.x, e.y - 40, '💥 SURFACE BURST – ' + pct + '% into the rock', '#ffe27a', 18, 2.4);
          } else {
            fx.text(e.x, e.y - 40, '⛏️ BURIED BLAST! ' + pct + '% into the rock', '#ff8c7a', 20, 2.6);
            unlock('buried');
            if (G.world.pens.some((q) => q.kind === 'kinetic' && q.state === 'done')) unlock('haiv');
          }
          break;
        }
        case 'penLaunch':
          audio.play('launch');
          fx.text(e.pen.x, e.pen.y - 22, '🚀 #' + e.pen.label + ' launched!', e.pen.kind === 'nuke' ? '#ffc23d' : '#4fd8ff', 14, 1.4);
          G.lastAction = w.t;
          break;
        case 'penLost':
          if (e.pen.kind === 'nuke' && e.pen.fuse === 'manual' && !e.pen.contact) fx.text(clamp(e.pen.x, 60, VIEW.w - 60), clamp(e.pen.y, 80, VIEW.h - 90), '☢️ #' + e.pen.label + ' never went off!', '#ffc23d', 14, 2);
          else fx.text(clamp(e.pen.x, 60, VIEW.w - 60), clamp(e.pen.y, 80, VIEW.h - 90), '#' + e.pen.label + ' missed', '#9fb0d6', 13, 1.6);
          break;
        case 'outcome': {
          const s = G.stats;
          s[e.outcome]++;
          s.damage += e.damage;
          s.largest = Math.max(s.largest, e.sizeM);
          fx.outcome(e);
          audio.play(e.outcome === 'burn' ? 'burn' : e.outcome);
          if (e.outcome === 'burn') unlock('shooting_stars');
          if (e.outcome === 'small') unlock('chelyabinsk');
          if (e.outcome === 'big') unlock('tunguska');
          if (e.outcome === 'ground') unlock(e.effM < 250 ? 'meteor_crater' : 'dinosaurs');
          break;
        }
        case 'miss':
          G.stats.miss++;
          G.stats.largestMiss = Math.max(G.stats.largestMiss, e.sizeM);
          if (e.effM >= 15) fx.text(clamp(e.x, 70, VIEW.w - 70), clamp(e.y, 80, VIEW.h - 90), '💨 Missed Earth!', '#9cc3ff', 14, 1.8, 'miss');
          if (G.stats.miss === 1) unlock('gravity');
          break;
      }
    }
    w.events.length = 0;
  }

  function finishRun(forced) {
    if (G.mode !== 'run') return;
    if (forced) {
      for (const b of G.world.bodies) {
        const h = G.world.headingForEarth(b);
        if (!h) { G.stats.miss++; continue; }
        const m = effM(b), o = ED.classifyEntry(m);
        G.stats[o]++;
        G.stats.damage += ED.entryDamage(o, m);
        G.stats.largest = Math.max(G.stats.largest, b._sizeM);
      }
    }
    G.mode = 'results';
    const stars = ED.starsFor(G.stats);
    if (!G.level.isSandbox) {
      const id = G.level.id;
      save.stars[id] = Math.max(save.stars[id] || 0, stars);
      persist();
    }
    unlock('scale', true);
    {
      const s = G.stats;
      const D0 = Math.max(...G.level.asteroids.map((a) => a.diameterM));
      if (s.burn + s.small + s.big + s.ground === 0 && s.largestMiss >= 0.5 * D0) unlock('deflection');
    }
    if (stars >= 1 && G.level.idx >= 2) unlock('apophis', true);
    if (G.stats.big + G.stats.ground > 0) unlock('fragments', true);
    updateUI();
    setTimeout(() => showResults(stars), 300);
  }

  // ---------------------------------------------------------------------------
  // Mission computer: re-simulates the plan in the background whenever it changes
  // ---------------------------------------------------------------------------
  let tlUiT = 0, tlDragging = false, tlHinted = false, tipShown = false;
  function updateMissionComputer(dt) {
    if (!G.pens.length) {
      G.rec = null;
      G.recReady = null;
      G.recStale = false;
      G.tlT = 0;
      G.tlPlay = false;
    } else {
      if (G.recStale && !G.drag && G.t - G.recStaleT > 0.3) {
        const maxDelay = Math.max(0, ...G.pens.map((p) => p.delay || 0));
        const tEnd = clamp(maxDelay + 3.5, 4, S.MAX_DELAY + 3);
        G.rec = new ED.Recorder(G.level.asteroids, G.pens.map((p) => Object.assign({}, p)), tEnd);
        G.recStale = false;
      }
      if (G.rec && G.rec.run(7)) {
        G.recReady = G.rec;
        G.rec = null;
        G.predDirty = true;
        G.tlT = Math.min(G.tlT, G.recReady.duration());
      }
      if (G.tlPlay && G.recReady) {
        G.tlT += dt;
        if (G.tlT >= G.recReady.duration()) {
          G.tlT = G.recReady.duration();
          G.tlPlay = false;
        }
      }
      if (!tlHinted && G.pens.some((p) => p.delay > 0)) {
        tlHinted = true;
        G.tlOpen = true;
        showHint(`🔮 Drag the <b>Mission computer</b> slider to see where the pieces will be – then ${tap()} a piece to hunt it!`, 6000);
      }
    }
    tlUiT -= dt;
    if (tlUiT <= 0) {
      tlUiT = 0.1;
      updateTimelineUI();
    }
  }

  function updateTimelineUI() {
    const el = $('timeline');
    const avail = G.mode === 'design' && G.pens.length > 0;
    const show = avail && G.tlOpen;
    el.classList.toggle('hidden', !show);
    $('btn-tl').classList.toggle('hidden', !avail);
    $('btn-tl').classList.toggle('on', show);
    $('btn-tl').classList.toggle('busy', !!G.rec);
    // sit just above the bottom bar, however tall it is
    const pal = $('palette');
    const barH = pal.classList.contains('hidden') ? 0 : pal.offsetHeight;
    el.style.bottom = barH + 8 + 'px';
    $('toasts').style.bottom = barH + (show ? 64 : 12) + 'px';
    if (!show) return;
    const slider = $('tl-slider');
    const dur = G.recReady ? G.recReady.duration() : 0;
    slider.max = dur.toFixed(2);
    slider.disabled = !G.recReady;
    if (!tlDragging) slider.value = G.tlT;
    $('tl-time').textContent = G.tlT > 0.02 ? 'T+' + G.tlT.toFixed(1) + ' s' : 'Now';
    const st = $('tl-status');
    st.className = G.rec || G.recStale ? 'busy' : G.recReady ? 'ready' : '';
    st.title = G.rec ? 'Thinking… ' + Math.round(G.rec.progress() * 100) + '%' : G.recStale ? 'Updating…' : 'Up to date';
    $('tl-play').textContent = G.tlPlay ? '⏸' : '▶';
  }

  $('tl-slider').addEventListener('input', () => {
    G.tlT = parseFloat($('tl-slider').value) || 0;
    G.tlFollow = false;
    G.tlPlay = false;
    tlHinted = true;
    if (G.tlT > 0.3) unlock('simulation');
    updateTimelineUI();
  });
  $('tl-slider').addEventListener('pointerdown', () => { tlDragging = true; });
  window.addEventListener('pointerup', () => { tlDragging = false; });
  $('btn-tl').addEventListener('click', () => {
    audio.init();
    audio.play('click');
    G.tlOpen = !G.tlOpen;
    if (!G.tlOpen) {
      G.tlT = 0;
      G.tlPlay = false;
      G.tlFollow = false;
    } else unlock('simulation');
    updateTimelineUI();
  });
  $('tl-close').addEventListener('click', () => {
    G.tlOpen = false;
    G.tlT = 0;
    G.tlPlay = false;
    G.tlFollow = false;
    updateTimelineUI();
  });
  $('tl-play').addEventListener('click', () => {
    audio.init();
    if (!G.recReady) return;
    if (!G.tlPlay && G.tlT >= G.recReady.duration() - 0.05) G.tlT = 0;
    G.tlPlay = !G.tlPlay;
    G.tlFollow = false;
    unlock('simulation');
    updateTimelineUI();
  });

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  let statT = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    G.t += dt;
    try {
      update(dt);
      render();
    } catch (err) {
      console.error(err);
    }
    requestAnimationFrame(frame);
  }

  function update(dt) {
    let rate = 1;
    if (G.mode === 'design') {
      updateMissionComputer(dt);
      refreshPredictions();
    } else if (G.mode === 'run') {
      const w = G.world;
      // manual nukes: slow time down as they approach
      const mans = manualNukes();
      let near = null;
      for (const p of mans) {
        const st = w.nukeStatus(p);
        st.distM = st.body ? st.dist * st.body.ast.mpp : 0;
        p.st = st;
        if (st.regime !== 'far' && st.dist < 150 && (!near || st.dist < near.st.dist)) near = p;
      }
      const wasSlow = G.slowmo;
      G.slowmo = !!near;
      if (G.slowmo && !wasSlow) audio.play('slowmo');
      G.armedNuke = near || mans[0] || null;
      updateDetonateButton(mans);

      rate = G.speed;
      if (G.slowmo) rate = Math.min(G.speed, 1) * 0.16;
      else if (G.hitStop > 0) rate *= 0.3;
      G.hitStop -= dt;

      G.acc += dt * rate;
      let n = 0;
      while (G.acc >= DT && n < 48) {
        w.step(DT);
        G.acc -= DT;
        n++;
        if (w.events.length) handleEvents();
        if (G.mode !== 'run') break;
      }
      if (n >= 48) G.acc = 0;

      // engine exhaust + plasma trails
      for (const p of w.pens) if (p.state === 'fly' && Math.random() < rate * 1.5) fx.exhaust(p);
      for (const e of w.entries) if (Math.random() < Math.min(1, rate * 2)) fx.plasma(e.body, e.scale, e.sizeM);

      // after the action, speed things up a little
      const allSpent = !w.pens.some((p) => p.state === 'fly' || p.state === 'wait');
      if (allSpent && !G.autoFast && G.speed === 1 && w.t - G.lastAction > 2.5 && w.bodies.length) {
        G.autoFast = true;
        G.speed = 2;
        syncSpeedButtons();
        toast('⏩ Speeding up time…');
      }
      if (w.isResolved()) {
        G.endTimer += dt;
        if (G.endTimer > 1.4) finishRun(false);
      } else if (w.t > 70) {
        finishRun(true);
      }
      statT -= dt;
      if (statT <= 0) {
        statT = 0.2;
        updateRunStats();
      }
    } else if (G.mode === 'menu' && G.demo) {
      G.demo.a += dt * 0.07;
    }
    fx.update(dt * (G.mode === 'run' ? rate : 1));
  }

  function render() {
    R.begin(G.t, fx.shake);
    const g = R.ctx;
    const design = G.mode === 'design';
    R.drawEarth(fx, G.t, { labels: design || G.mode === 'menu' });

    if (G.mode === 'menu') {
      if (G.demo) R.drawBody(G.demo, { a: G.demo.a });
      R.drawParticles(fx);
      return;
    }
    if (!G.world) return;
    const w = G.world;

    if (design) {
      R.drawZone(G.t, !!G.armed || !!(G.pdrag && G.pdrag.moved));
      for (const T of G.pred.targets) R.drawAsteroidPath(T, G.t);
    }
    const holo = design && G.tlOpen && G.recReady && G.tlT > 0.02;
    for (const b of w.bodies) R.drawBody(b, holo ? { alpha: 0.22 } : null);
    for (const e of w.entries) R.drawBody(e.body, { scale: e.scale, heat: 1, hot: true });
    R.drawCrackGlows(w);
    if (holo) R.drawHologram(G.recReady, G.tlT, G.pens);

    if (design) {
      // ghost of the asteroid at the moment the selected penetrator hits
      const si = G.sel ? G.pens.indexOf(G.sel) : -1;
      const sp = si >= 0 ? G.preds[si] : null;
      if (sp && sp.hit && !sp.viaRec && !holo) {
        const T = G.pred.targets[sp.target];
        R.drawBody(T.body, { x: T.px[sp.step], y: T.py[sp.step], a: T.pa[sp.step], alpha: 0.22, heat: 0 });
      }
      G.pens.forEach((p, i) => {
        const pr = G.preds[i];
        if (!pr) return;
        R.drawPrediction(p, pr, { selected: p === G.sel });
      });
      G.pens.forEach((p, i) => {
        const pr = G.preds[i];
        if (pr && pr.hit && !pr.viaRec) {
          const T = G.pred.targets[pr.target];
          const [x, y] = T.body.toWorld(pr.gx, pr.gy);
          R.drawReticle(x, y, p.kind, String(i + 1), p === G.sel);
        }
      });
      G.pens.forEach((p, i) => {
        R.drawAimArrow(p, AIM_K, p === G.sel, touchUI.on);
        R.drawPen(p.x, p.y, Math.atan2(p.vy, p.vx), p.kind, { selected: p === G.sel, hover: p === G.hover, label: String(i + 1) });
        if (p.delay > 0) R.label(p.x + 12, p.y + 22, '⏱ T+' + p.delay.toFixed(2) + 's', '#ffe9a8', 11);
      });
    } else {
      for (const p of w.pens) {
        if (p.state === 'wait') {
          R.drawPen(p.x, p.y, Math.atan2(p.vy, p.vx), p.kind, { label: p.label });
          R.label(p.x, p.y + 26, '⏱ ' + Math.max(0, p.delay - w.t).toFixed(1), '#ffe9a8', 12, 'center');
          continue;
        }
        if (p.state !== 'fly') continue;
        R.drawPen(p.x, p.y, Math.atan2(p.vy, p.vx), p.kind, { flame: true, label: p.label });
        if (p.kind === 'nuke' && p.fuse === 'manual') R.drawNukeMeter(p, p.st);
      }
    }

    if (design && G.pdrag && G.pdrag.moved) {
      const d = G.pdrag, ok = inZone(d.x, d.y);
      g.save();
      g.globalAlpha = 0.85;
      g.strokeStyle = ok ? 'rgba(110,255,180,0.9)' : 'rgba(255,90,100,0.9)';
      g.lineWidth = 2;
      g.setLineDash([4, 4]);
      g.beginPath(); g.arc(d.x, d.y, 22, 0, Math.PI * 2); g.stroke();
      g.restore();
      R.drawPen(d.x, d.y, 0, d.kind, {});
    }
    R.drawParticles(fx);
    R.drawFlashes(fx);

    if (G.mode === 'run' && $('opt-track').checked) {
      for (const b of w.bodies) {
        const m = effM(b);
        if (m < 15) continue;
        const hit = w.headingForEarth(b);
        if (!hit) continue;
        R.drawThreat(b, hit, ED.classifyEntry(m), m, b._sizeM);
      }
      // big pieces that have been pushed onto a path that misses Earth
      const savers = [];
      for (const b of w.bodies) {
        const m = effM(b);
        if (m < 30 || w.headingForEarth(b)) continue;
        const ca = w.closestApproach(b);
        if (ca && ca.dist < E.atm * 2 && ca.t < 30) savers.push([m, b]);
      }
      savers.sort((a, b) => b[0] - a[0]);
      for (const [, b] of savers.slice(0, 4)) R.label(b.x + b.rad * 0.7 + 4, b.y + b.rad * 0.7 + 12, '✓ will miss', '#7dffb6', 12);
    }
    R.drawTexts(fx);
    if (G.slowmo) {
      g.save();
      g.fillStyle = 'rgba(120,180,255,0.07)';
      g.fillRect(0, 0, VIEW.w, VIEW.h);
      g.restore();
    }
    R.screenFlash(fx.screenFlash);
  }

  // ---------------------------------------------------------------------------
  // Pointer input (mouse, touch and Apple Pencil)
  // ---------------------------------------------------------------------------
  // Fingers are fat and wobbly: bigger hit areas and a small dead zone before a drag.
  const isFinger = (ev) => ev.pointerType === 'touch' || ev.pointerType === 'pen';
  const reach = (ev, mouse, finger) => (isFinger(ev) ? finger : mouse);

  function penAt(x, y, r) {
    let best = null, bd = r || 16;
    for (const p of G.pens) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function asteroidAt(x, y) {
    const c = G.world.cellAt(x, y, null, 1.7);
    if (!c) return null;
    const k = G.pred.targets.findIndex((T) => T.body === c.body);
    return k >= 0 ? { k, body: c.body } : null;
  }
  function handleAt(x, y, r) {
    const p = G.sel;
    if (!p) return false;
    return Math.hypot(p.x + p.vx * AIM_K - x, p.y + p.vy * AIM_K - y) < (r || 15);
  }
  function nukeAt(x, y, r) {
    let best = null, bd = r;
    for (const p of manualNukes()) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  let activePointer = null; // ignore extra fingers while one is busy
  canvas.addEventListener('pointerdown', (ev) => {
    audio.init();
    if (activePointer !== null && ev.pointerId !== activePointer) return;
    const [x, y] = R.toWorld(ev.clientX, ev.clientY);
    if (G.mode === 'run') {
      // tap a manual nuke to blow it
      const n = nukeAt(x, y, reach(ev, 30, 48));
      if (n) G.world.detonate(n, 'manual');
      return;
    }
    if (G.mode !== 'design') return;
    if (ev.button === 2) {
      const p = penAt(x, y);
      if (p) removePen(p);
      return;
    }
    activePointer = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (handleAt(x, y, reach(ev, 15, 28))) {
      G.drag = { type: 'aim', pen: G.sel };
      return;
    }
    const p = penAt(x, y, reach(ev, 16, 28));
    if (p) {
      select(p);
      G.drag = { type: 'move', pen: p, dx: p.x - x, dy: p.y - y, sx: ev.clientX, sy: ev.clientY, moved: false };
      return;
    }
    if (G.tlOpen && G.recReady && G.tlT > 0.02 && !inZone(x, y)) {
      const id = G.recReady.nearestCell(x, y, G.tlT, reach(ev, 18, 32));
      if (id >= 0) {
        if (!G.sel) {
          showHint(`Select one of your penetrators first, then ${tap()} a piece of the hologram to hunt it down.`, 4000);
          return;
        }
        G.recReady.aimAtCell(G.sel, id, G.tlT);
        G.tlFollow = true;
        tlHinted = true;
        planChanged();
        audio.play('click');
        unlock('simulation');
        showHint('🎯 #' + penLabel(G.sel) + (G.sel.delay > 0 ? ' will launch at T+' + G.sel.delay.toFixed(2) + ' s' : ' launches right away') + ' to intercept that piece.', 3500);
        return;
      }
    }
    const a = asteroidAt(x, y);
    if (a && G.sel) {
      const [gx, gy] = a.body.toGen(x, y);
      G.pred.aimAt(G.sel, a.k, gx, gy);
      planChanged();
      audio.play('click');
      if (G.tut === 2) G.tut = 3;
      updateTutorial();
      return;
    }
    if (a && !G.sel) {
      showHint(`Select one of your penetrators first, then ${tap()} the asteroid to choose where it hits.`, 4000);
      return;
    }
    if (inZone(x, y)) {
      if (G.armed) {
        placePen(G.armed, x, y);
        return;
      }
      if (G.sel) {
        select(null);
        return;
      }
      // nothing chosen yet: if only one kind is left, just place it
      const kinds = ['kinetic', 'nuke'].filter((k) => left(k) > 0);
      if (kinds.length === 1) placePen(kinds[0], x, y);
      else if (kinds.length) showHint('👇 Choose a penetrator from the bar at the bottom first – or drag one straight into the green zone.', 3500);
      return;
    }
    select(null);
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (activePointer !== null && ev.pointerId !== activePointer) return;
    const [x, y] = R.toWorld(ev.clientX, ev.clientY);
    if (G.mode !== 'design') {
      if (ev.pointerType === 'mouse') canvas.style.cursor = G.mode === 'run' && nukeAt(x, y, 30) ? 'pointer' : 'default';
      return;
    }
    const d = G.drag;
    if (d && d.type === 'aim') {
      const p = d.pen;
      let vx = (x - p.x) / AIM_K, vy = (y - p.y) / AIM_K;
      const sp = Math.hypot(vx, vy) || 1;
      const s = clamp(sp, S.PEN_MIN, S.PEN_MAX);
      p.vx = (vx / sp) * s;
      p.vy = (vy / sp) * s;
      planChanged();
      if (G.tut === 2) G.tut = 3;
      return;
    }
    if (d && d.type === 'move') {
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < (isFinger(ev) ? 9 : 3)) return;
      d.pen.x = clamp(x + d.dx, ZONE.x0, ZONE.x1);
      d.pen.y = clamp(y + d.dy, ZONE.y0, ZONE.y1);
      d.moved = true;
      planChanged();
      return;
    }
    if (ev.pointerType !== 'mouse') return;
    const p = penAt(x, y);
    G.hover = p;
    let cur = 'default';
    if (handleAt(x, y) || p) cur = 'grab';
    else if (G.sel && asteroidAt(x, y)) cur = 'crosshair';
    else if (G.armed && inZone(x, y)) cur = 'copy';
    canvas.style.cursor = cur;
  });

  const endDrag = (ev) => {
    if (ev && activePointer !== null && ev.pointerId !== activePointer) return;
    activePointer = null;
    if (G.drag) {
      G.drag = null;
      renderPanel();
      updateTutorial();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Drag a penetrator straight from the bottom bar into the green zone.
  // On touch the ghost floats above the finger so you can see where it will land.
  let suppressClick = false;
  function paletteDown(ev) {
    audio.init();
    if (G.mode !== 'design' || G.pdrag) return;
    const b = ev.currentTarget;
    G.pdrag = { kind: b.dataset.kind, id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, moved: false, x: 0, y: 0, lift: isFinger(ev) ? 56 : 0 };
    try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
  }
  function paletteMove(ev) {
    const d = G.pdrag;
    if (!d || d.id !== ev.pointerId) return;
    if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 12) {
      if (left(d.kind) <= 0) {
        G.pdrag = null;
        return;
      }
      d.moved = true;
    }
    if (d.moved) [d.x, d.y] = R.toWorld(ev.clientX, ev.clientY - d.lift);
  }
  function paletteUp(ev) {
    const d = G.pdrag;
    if (!d || d.id !== ev.pointerId) return;
    G.pdrag = null;
    if (!d.moved) return; // a plain tap: the click handler arms it
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    if (ev.type !== 'pointerup') return;
    if (inZone(d.x, d.y)) placePen(d.kind, d.x, d.y);
    else showHint('Drop it inside the green zone!', 2500);
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    audio.init();
    if (ev.code === 'Escape') {
      if (!$('overlay').classList.contains('hidden') && G.mode !== 'menu' && G.mode !== 'results') closeModal();
      else if (G.mode === 'design') { G.armed = null; select(null); updateUI(); }
      return;
    }
    if (!$('overlay').classList.contains('hidden')) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (G.mode === 'run') detonateNow();
      else if (G.mode === 'design') launch();
    } else if ((ev.code === 'Delete' || ev.code === 'Backspace') && G.mode === 'design' && G.sel) {
      ev.preventDefault();
      removePen(G.sel);
    } else if (ev.code === 'Digit1' && G.mode === 'design') {
      arm('kinetic');
    } else if (ev.code === 'Digit2' && G.mode === 'design') {
      arm('nuke');
    }
  });

  window.addEventListener('resize', () => R.resize());

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function arm(kind) {
    if (left(kind) <= 0) {
      toast(kind === 'nuke' ? (G.level.inventory.nuke ? 'All your nukes are placed.' : 'No nukes on this mission!') : 'All your impactors are placed.');
      return;
    }
    G.armed = G.armed === kind ? null : kind;
    audio.play('click');
    if (G.tut === 0 && G.armed) G.tut = 1;
    updateUI();
  }

  document.querySelectorAll('.pen-btn').forEach((b) => {
    b.addEventListener('pointerdown', paletteDown);
    b.addEventListener('pointermove', paletteMove);
    b.addEventListener('pointerup', paletteUp);
    b.addEventListener('pointercancel', paletteUp);
    b.addEventListener('click', () => {
      if (suppressClick) return;
      audio.init();
      arm(b.dataset.kind);
    });
  });
  $('btn-launch').addEventListener('click', () => { audio.init(); launch(); });
  $('btn-clear').addEventListener('click', () => {
    if (!G.pens.length) return;
    G.pens = [];
    G.sel = null;
    planChanged();
    audio.play('remove');
    updateUI();
  });
  $('btn-abort').addEventListener('click', () => { audio.play('click'); startLevel(G.level, true); });
  $('btn-detonate').addEventListener('click', () => detonateNow());
  document.querySelectorAll('#speed-btns button').forEach((b) =>
    b.addEventListener('click', () => {
      G.speed = parseFloat(b.dataset.speed);
      G.autoFast = true;
      syncSpeedButtons();
      audio.play('click');
    })
  );
  $('btn-menu').addEventListener('click', () => { audio.init(); showPause(); });
  $('run-stats').addEventListener('click', () => toast('🪨 pieces still flying · ✨ burned up · 💨 missed Earth · 💥 small airbursts · 🌲 big airbursts · ☄️ craters'));

  // Full screen (where the browser allows it – iPad Safari does)
  const root = document.documentElement;
  const fsOn = () => document.fullscreenElement || document.webkitFullscreenElement;
  const fsOK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  function toggleFullscreen() {
    try {
      if (fsOn()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        const r = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        if (r && r.catch) r.catch(() => toast('Full screen isn’t available here.'));
      }
    } catch (e) {
      toast('Full screen isn’t available here.');
    }
  }
  $('btn-full').classList.toggle('hidden', !fsOK);
  $('btn-full').addEventListener('click', () => { audio.init(); toggleFullscreen(); });

  // iPad Safari: no pinch-zooming the game, and unlock sound on the first touch
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchend', () => audio.init(), { passive: true });
  $('btn-help').addEventListener('click', () => { audio.init(); showHelp(); });
  $('btn-book').addEventListener('click', () => { audio.init(); showBook(); });
  $('btn-sound').addEventListener('click', () => {
    audio.init();
    const on = audio.toggle();
    $('btn-sound').textContent = on ? '🔊' : '🔇';
  });
  $('btn-sound').textContent = audio.on ? '🔊' : '🔇';

  function syncSpeedButtons() {
    document.querySelectorAll('#speed-btns button').forEach((b) => b.classList.toggle('on', parseFloat(b.dataset.speed) === G.speed));
  }

  function updateUI() {
    const m = G.mode;
    const inGame = m === 'design' || m === 'run' || m === 'results';
    $('topbar').classList.toggle('hidden', !inGame);
    $('palette').classList.toggle('hidden', m !== 'design');
    $('runbar').classList.toggle('hidden', m !== 'run');
    updateTimelineUI();
    $('run-stats').classList.toggle('hidden', m !== 'run' && m !== 'results');
    if (m !== 'run') $('btn-detonate').classList.add('hidden');
    if (G.level && inGame) {
      $('mission-num').textContent = G.level.isSandbox ? '🧪' : 'Mission ' + G.level.num;
      $('mission-name').textContent = G.level.name;
      $('asteroid-chip').innerHTML = G.level.asteroids
        .map((a) => `<span>${ED.ASTEROID_TYPES[a.type].icon} ${ED.ASTEROID_TYPES[a.type].name} · ${a.diameterM} m</span>`)
        .join('');
    }
    if (m === 'design') {
      for (const kind of ['kinetic', 'nuke']) {
        const btn = document.querySelector(`.pen-btn[data-kind="${kind}"]`);
        const total = G.level.inventory[kind];
        btn.classList.toggle('hidden', total === 0);
        btn.classList.toggle('armed', G.armed === kind);
        btn.classList.toggle('empty', left(kind) <= 0);
        btn.querySelector('.count').textContent = `${left(kind)} left`;
        btn.querySelector('.pb-n').textContent = left(kind);
      }
      $('btn-launch').classList.toggle('ready', G.pens.length > 0);
      $('btn-clear').classList.toggle('hidden', G.pens.length === 0);
    }
    if (m === 'run') {
      syncSpeedButtons();
      updateRunStats();
    }
    renderPanel();
    updateTutorial();
  }

  function updateRunStats() {
    const s = G.stats;
    if (!s) return;
    const w = G.world;
    const pieces = w ? w.bodies.length + w.entries.length : 0;
    $('run-stats').innerHTML =
      `<span title="Pieces still flying">🪨 ${pieces}</span>` +
      `<span title="Burned up">✨ ${s.burn}</span>` +
      `<span title="Missed Earth">💨 ${s.miss}</span>` +
      `<span title="Small airbursts" class="${s.small ? 'warn' : ''}">💥 ${s.small}</span>` +
      `<span title="Big airbursts" class="${s.big ? 'warn2' : ''}">🌲 ${s.big}</span>` +
      `<span title="Ground impacts" class="${s.ground ? 'bad' : ''}">☄️ ${s.ground}</span>`;
    const pct = Math.min(100, s.damage);
    $('damage-fill').style.width = pct + '%';
    $('damage-fill').className = 'fill ' + (s.ground ? 'bad' : s.damage > 14 ? 'warn2' : s.damage > 3 ? 'warn' : 'ok');
    $('damage-text').textContent = s.ground ? 'Crater!' : s.damage > 14 ? 'Serious' : s.damage > 3 ? 'Minor' : 'Safe';
  }

  function updateDetonateButton(mans) {
    const btn = $('btn-detonate');
    if (!mans.length) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    btn.classList.toggle('pulse', G.slowmo);
    const p = G.armedNuke;
    btn.querySelector('.det-label').textContent = p ? 'DETONATE #' + p.label : 'DETONATE';
  }

  let hintTimer = null;
  function showHint(html, ms) {
    const el = $('hint');
    el.innerHTML = html;
    el.classList.remove('hidden');
    clearTimeout(hintTimer);
    if (ms) hintTimer = setTimeout(hideHint, ms);
  }
  function hideHint() {
    $('hint').classList.add('hidden');
    clearTimeout(hintTimer);
  }

  function updateTutorial() {
    document.querySelectorAll('.tut-glow').forEach((e) => e.classList.remove('tut-glow'));
    if (G.mode !== 'design' || G.tut < 0) return;
    if (G.tut === 0 && (G.armed || G.pens.length)) G.tut = 1;
    if (G.tut === 1 && G.pens.length) G.tut = 2;
    if (G.tut === 2 && G.pens.length >= 2) G.tut = 3;
    if (G.tut >= 2 && left('kinetic') === 0) G.tut = 4;
    const steps = [
      [`👇 Step 1: ${tap(1)} the <b>🚀 Kinetic Impactor</b> button${touchUI.on ? ' – or drag it into the green zone' : ''}.`, '.pen-btn[data-kind="kinetic"]'],
      [`📍 Step 2: ${tap(1)} anywhere inside the <b>green zone</b> to place it.`, null],
      [`🎯 Step 3: The dotted line and <b>✕</b> show where it will hit! ${tap(1)} a spot on the asteroid to aim there – or drag the white handle.`, null],
      ['🚀 Step 4: Place all 3 impactors – try hitting from below to push pieces up and away from Earth!', '.pen-btn[data-kind="kinetic"]'],
      ['🔥 Ready? Press <b>LAUNCH!</b>', '#btn-launch'],
    ];
    const s = steps[Math.min(G.tut, steps.length - 1)];
    showHint(s[0]);
    if (s[1]) {
      const el = document.querySelector(s[1]);
      if (el) el.classList.add('tut-glow');
    }
  }

  // Controls for the selected penetrator, docked in the bottom bar so they never
  // cover the play area. With nothing selected the dock shows the swarm count.
  function renderPanel() {
    const dock = $('dock');
    const pal = $('palette');
    const p = G.mode === 'design' ? G.sel : null;
    pal.classList.toggle('inspecting', !!p);
    if (!p) {
      if (G.level && G.mode === 'design') {
        const total = G.level.inventory.kinetic + G.level.inventory.nuke;
        dock.innerHTML = `<span class="dock-idle">Swarm <b>${G.pens.length}/${total}</b>${G.pens.length ? ` · ${tap()} a penetrator to change it` : ''}</span>`;
      }
      return;
    }
    const i = G.pens.indexOf(p);
    const pr = G.preds[i];
    const sp = Math.hypot(p.vx, p.vy);
    const T = G.pred.targets[pr && pr.hit && pr.target != null ? pr.target : nearestTarget(p.x, p.y)];
    const rel = Math.hypot(p.vx - T.body.vx, p.vy - T.body.vy);
    const tons = ED.PHYS.tntTons(S.IMPACTOR_KG, kms(rel));
    const nuke = p.kind === 'nuke';
    let status = '';
    if (pr && pr.approx) status = '<span class="muted">🔮 working it out…</span>';
    else if (pr) {
      status = pr.hit
        ? `<span class="ok">✅ ${pr.standoff ? 'goes off' : 'hits'} at T+${pr.t.toFixed(1)} s</span>`
        : `<span class="bad">❌ will miss</span>`;
    }
    let html = `<span class="insp-id ${nuke ? 'nuk' : 'kin'}" title="${nuke ? 'Nuclear Penetrator' : 'Kinetic Impactor'}">${nuke ? '☢️' : '🚀'}#${i + 1}</span>`;
    html += `<span class="insp-info"><span>${kms(sp).toFixed(1)} km/s · ${nuke ? '100 kt' : '≈ ' + fmtTons(tons) + ' TNT'}</span>${status}</span>`;
    if (!nuke) {
      const f = clamp(rel / (S.PEN_MAX + 80), 0, 1);
      html += `<span class="insp-meters" title="Slow = gentle push. Fast = big smash."><span>↗️</span><span class="m"><i style="width:${Math.round(f * 100)}%"></i></span><span>💥</span><span class="m"><i style="width:${Math.round(Math.pow(f, 1.5) * 100)}%"></i></span></span>`;
    }
    const dl = p.delay || 0;
    html += `<span class="insp-group" title="Launch delay"><button data-act="delay-" aria-label="Launch sooner">−</button><b>⏱ ${dl > 0 ? dl.toFixed(2) + 's' : 'now'}</b><button data-act="delay+" aria-label="Launch later">+</button></span>`;
    if (nuke) {
      const f = ED.FUSES[p.fuse];
      html += `<span class="insp-group"><button data-act="fuse-menu" class="fuse-cur" title="Fuse: ${esc(f.name)} – ${esc(f.text)}" aria-label="Fuse: ${esc(f.name)}">${f.icon}<small>${esc(f.name)}</small>▾</button></span>`;
    }
    html += '<span class="insp-group">';
    html += '<button data-act="centre" title="Aim at the middle of the asteroid" aria-label="Aim at centre">🎯</button>';
    if (left('kinetic') > 0) html += '<button data-act="follow-kinetic" title="Put an impactor right behind this one" aria-label="Add impactor behind">➕🚀</button>';
    if (left('nuke') > 0) html += '<button data-act="follow-nuke" title="Put a nuke right behind this one" aria-label="Add nuke behind">➕☢️</button>';
    html += '<button data-act="delete" class="danger" title="Remove (Delete key)" aria-label="Remove">🗑</button>';
    html += '<button data-act="close" class="done" title="Done" aria-label="Done">✓</button>';
    html += '</span>';
    dock.innerHTML = html;
  }

  // Fuse chooser: pops up above the fuse button with a name and explanation for each
  function openFuseMenu(btn) {
    const pop = $('fuse-pop');
    pop.innerHTML = Object.entries(ED.FUSES).map(([k, f]) =>
      `<button data-fuse="${k}" class="${G.sel.fuse === k ? 'on' : ''}"><span class="fi">${f.icon}</span><span><b>${esc(f.name)}</b><br>${esc(f.text)}</span></button>`).join('');
    pop.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
    pop.style.top = Math.max(8, r.top - h - 10) + 'px';
  }
  function closeFuseMenu() {
    $('fuse-pop').classList.add('hidden');
  }
  $('fuse-pop').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !G.sel) return;
    audio.play('click');
    G.sel.fuse = b.dataset.fuse;
    closeFuseMenu();
    planChanged();
    renderPanel();
  });
  window.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('#fuse-pop') && !ev.target.closest('[data-act="fuse-menu"]')) closeFuseMenu();
  }, true);

  $('dock').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !G.sel) return;
    audio.play('click');
    const act = b.dataset.act;
    if (act === 'fuse-menu') {
      if ($('fuse-pop').classList.contains('hidden')) openFuseMenu(b);
      else closeFuseMenu();
      return;
    }
    if (act === 'close') select(null);
    else if (act === 'centre') { aimAtCentre(G.sel); planChanged(); }
    else if (act === 'delay+' || act === 'delay-') {
      const d = (G.sel.delay || 0) + (act === 'delay+' ? 0.25 : -0.25);
      G.sel.delay = Math.round(clamp(d, 0, S.MAX_DELAY) * 4) / 4;
      G.tlFollow = G.sel.delay > 0;
      if (G.sel.delay > 0) G.tlOpen = true;
      planChanged();
      renderPanel();
    }
    else if (act === 'follow-kinetic') addFollower(G.sel, 'kinetic');
    else if (act === 'follow-nuke') addFollower(G.sel, 'nuke');
    else if (act === 'delete') removePen(G.sel);
  });

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------
  function openModal(html, cls) {
    const m = $('modal');
    m.className = 'modal ' + (cls || '');
    m.innerHTML = html;
    $('overlay').classList.remove('hidden');
    $('overlay').scrollTop = 0;
    hideHint();
    return m;
  }
  function closeModal() {
    $('overlay').classList.add('hidden');
  }

  $('modal').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    audio.init();
    audio.play('click');
    const act = b.dataset.act;
    switch (act) {
      case 'title': showTitle(); break;
      case 'missions': showLevels(); break;
      case 'level': {
        const i = parseInt(b.dataset.level, 10);
        if (levelUnlocked(i)) showBriefing(i);
        break;
      }
      case 'unlockall': save.unlockAll = true; persist(); showLevels(); break;
      case 'plan': startLevel(levelFromIndex(G.levelIdx), false); break;
      case 'retry': startLevel(G.level, true); break;
      case 'fresh': startLevel(G.level, false); break;
      case 'next': showBriefing(G.level.idx + 1); break;
      case 'sandbox': showSandbox(); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'sb-start': startSandbox(); break;
      case 'help': showHelp(b.dataset.back); break;
      case 'book': showBook(null, b.dataset.back); break;
      case 'resume': closeModal(); updateTutorial(); break;
      case 'back-results': showResults(ED.starsFor(G.stats)); break;
      case 'close': if (G.mode === 'menu') showTitle(); else if (G.mode === 'results') showResults(ED.starsFor(G.stats)); else { closeModal(); updateTutorial(); } break;
      case 'sb': {
        const k = b.dataset.key, v = b.dataset.val;
        const cfg = G.sandboxCfg;
        if (k === 'kinetic' || k === 'nuke') {
          const other = k === 'kinetic' ? 'nuke' : 'kinetic';
          cfg[k] = clamp(cfg[k] + parseInt(v, 10), 0, MAX_SWARM - cfg[other]);
        } else cfg[k] = v;
        showSandbox();
        break;
      }
    }
  });

  function showTitle() {
    G.mode = 'menu';
    G.level = null;
    G.world = null;
    fx.reset();
    if (!G.demo) {
      const w = new ED.World(1);
      G.demo = w.addAsteroid({ type: 'pinata', diameterM: 300, radiusPx: 150, cellM: 14, seed: 5, x: 930, y: 380, speed: 0, aimX: 0, aimY: 380, spin: 0 });
    }
    updateUI();
    const n = save.facts.length, total = ED.FACT_ORDER.length;
    openModal(
      `<div class="title-card">
        <div class="logo"><span class="l1">EARTH</span><span class="l2">DEFENCE</span></div>
        <div class="subtitle">☄️ Asteroid Splitter Command ☄️</div>
        <p class="lead">A space rock is heading for Earth! Design a swarm of up to 10 penetrators, smash the asteroid apart, and find out which pieces burn up in the atmosphere.</p>
        <div class="menu-buttons">
          <button class="btn primary big" data-act="missions">🚀 Missions</button>
          <button class="btn" data-act="sandbox">🧪 Sandbox</button>
          <button class="btn" data-act="help" data-back="title">❓ How to play</button>
          <button class="btn" data-act="book" data-back="title">📖 Science logbook <span class="badge">${n}/${total}</span></button>
          ${fsOK ? '<button class="btn" data-act="fullscreen">⛶ Full screen</button>' : ''}
        </div>
        <p class="tiny">Not to scale – everything is squeezed to fit on screen and slowed down so you can watch the physics.</p>
      </div>`,
      'title'
    );
  }

  function starStr(n) {
    return '<span class="stars">' + [0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}">★</i>`).join('') + '</span>';
  }

  function showLevels() {
    G.mode = 'menu';
    updateUI();
    const cards = ED.LEVELS.map((L, i) => {
      const open = levelUnlocked(i);
      const icons = [...new Set(L.asteroids.map((a) => ED.ASTEROID_TYPES[a.type].icon))].join('');
      const inv = `🚀${L.inventory.kinetic}${L.inventory.nuke ? ' ☢️' + L.inventory.nuke : ''}`;
      return `<button class="level-card ${open ? '' : 'locked'}" data-act="level" data-level="${i}" ${open ? '' : 'disabled'}>
        <div class="lv-num">${i + 1}</div><div class="lv-icon">${open ? icons : '🔒'}</div>
        <div class="lv-name">${esc(L.name)}</div><div class="lv-inv">${inv}</div>${starStr(starsOf(i))}</button>`;
    }).join('');
    openModal(
      `<h2>🚀 Missions</h2><p class="muted">Earn at least one ★ to unlock the next mission.</p>
      <div class="level-grid">${cards}</div>
      <div class="row"><button class="btn" data-act="title">← Back</button><span class="grow"></span>${save.unlockAll ? '' : '<button class="link" data-act="unlockall">🔓 Unlock all missions</button>'}</div>`,
      'levels'
    );
  }

  function massText(a) {
    const T = ED.ASTEROID_TYPES[a.type];
    const r = a.diameterM / 2;
    const tonnes = (T.kgm3 * (4 / 3) * Math.PI * r * r * r) / 1000;
    const eiffel = tonnes / 10000;
    return `≈ <b>${fmtNum(tonnes)} tonnes</b> – as heavy as ${eiffel >= 1 ? fmtNum(eiffel) : eiffel.toFixed(1)} Eiffel Towers`;
  }

  function drawPreview(cv, spec) {
    const w = new ED.World(1);
    const b = w.addAsteroid(Object.assign({}, spec, { x: 0, y: 0, speed: 0, aimX: -1, aimY: 0 }));
    const g = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = cv.clientWidth || 200;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const sc = ((size * 0.86) / (b.rad * 2)) * dpr;
    g.setTransform(sc, 0, 0, sc, (size * dpr) / 2, (size * dpr) / 2);
    R.paintCells(g, b, 0.55, -0.5);
    // cut-away line to show the inside layers
  }

  function asteroidCard(a, idx) {
    const T = ED.ASTEROID_TYPES[a.type];
    const layers = T.layers.map(([m, txt]) => `<li><span class="swatch" style="background:${ED.MATERIALS[m].color}"></span>${esc(txt)}</li>`).join('');
    return `<div class="ast-card">
      <canvas class="ast-preview" data-idx="${idx}"></canvas>
      <div class="ast-name">${T.icon} ${esc(T.name)}</div>
      <ul class="layers">${layers}</ul>
      <div class="ast-stats"><div><b>${a.diameterM} m</b> wide</div><div>${massText(a)}</div></div>
    </div>`;
  }

  function showBriefing(i) {
    if (i >= ED.LEVELS.length) { showLevels(); return; }
    G.levelIdx = i;
    const L = levelFromIndex(i);
    G.mode = 'menu';
    updateUI();
    const types = [...new Set(L.asteroids.map((a) => a.type))];
    const info = types.map((t) => {
      const T = ED.ASTEROID_TYPES[t];
      return `<h3>${T.icon} ${esc(T.name)}</h3><p>${esc(T.desc)}</p><p class="real">🔬 ${esc(T.real)}</p>`;
    }).join('');
    const newFacts = [];
    for (const f of L.facts || []) if (unlock(f, true)) newFacts.push(f);
    for (const t of types) if (unlock(ED.ASTEROID_TYPES[t].fact, true)) newFacts.push(ED.ASTEROID_TYPES[t].fact);
    const factLine = (L.facts || []).map((f) => `<button class="chip" data-act="book" data-back="brief">${ED.FACTS[f].icon} ${esc(ED.FACTS[f].title)}${newFacts.includes(f) ? ' <em>new!</em>' : ''}</button>`).join('');
    const m = openModal(
      `<div class="brief">
        <div class="brief-head"><span class="pill">Mission ${L.num}</span><h2>${esc(L.name)}</h2>${starStr(starsOf(i))}${L.goal === 'deflect' ? '<span class="pill goal">↗️ Deflection mission</span>' : ''}${L.wave ? '<span class="pill goal">🌊 Second-wave mission</span>' : ''}</div>
        <p class="brief-text">${esc(L.briefing)}</p>
        <div class="brief-cols">
          <div class="ast-cards">${L.asteroids.map((a, k) => asteroidCard(a, k)).join('')}</div>
          <div class="brief-info">
            ${info}
            <h3>🛰️ Your swarm</h3>
            <div class="swarm"><span class="kin">🚀 × ${L.inventory.kinetic} Kinetic impactors</span>${L.inventory.nuke ? `<span class="nuk">☢️ × ${L.inventory.nuke} Nuclear penetrators</span>` : ''}</div>
            <div class="tip">💡 ${esc(L.tip)}</div>
            <div class="factline">📖 Logbook: ${factLine}</div>
          </div>
        </div>
        <div class="row"><button class="btn" data-act="missions">← Missions</button><span class="grow"></span><button class="btn primary big" data-act="plan">Plan my swarm ▶</button></div>
      </div>`,
      'brief-modal'
    );
    m.querySelectorAll('.ast-preview').forEach((cv) => drawPreview(cv, L.asteroids[+cv.dataset.idx]));
    updateBookBadge();
  }

  function showResults(stars) {
    const s = G.stats;
    const titles = [s.ground ? 'Earth was hit! 😱' : 'Too many big blasts! 😱', 'Earth survived… just! 😅', 'Great defending! 😃', 'PERFECT DEFENCE! 🤩'];
    const entered = s.burn + s.small + s.big + s.ground;
    const D0 = Math.max(...G.level.asteroids.map((a) => a.diameterM));
    const clean = entered === 0 && s.largestMiss >= 0.5 * D0;
    if (clean) titles[3] = '🎯 CLEAN DEFLECTION!';
    const rows = [
      ['burn', s.burn, 'Tiny pieces burned up like shooting stars'],
      ['miss', s.miss, 'Pieces pushed right past Earth'],
      ['small', s.small, 'Small airbursts – like Chelyabinsk, 2013'],
      ['big', s.big, 'Big airbursts – like Tunguska, 1908'],
      ['ground', s.ground, 'Hit the ground and made a crater'],
    ].map(([k, n, txt]) => {
      const o = ED.OUTCOMES[k];
      return `<div class="res-row ${n && (k === 'big' || k === 'ground') ? 'bad' : ''}"><span class="res-ico">${o.icon}</span><span class="res-n" style="color:${o.color}">${n}</span><span class="res-txt"><b>${o.label}</b><br>${txt}</span></div>`;
    }).join('');
    let advice;
    if (!s.hits && !s.nukes) advice = 'None of your penetrators hit the asteroid! Follow the dotted lines – the ✕ shows where each one will hit.';
    else if (s.ground) advice = 'A big chunk got all the way down. Hit harder near the middle, use more penetrators in a line, or push pieces sideways so they miss Earth.';
    else if (s.big) advice = 'No craters – but medium-sized pieces caused big airbursts. Break them smaller, or push them away from Earth.';
    else if (stars < 3) advice = 'Nearly perfect! A few pieces exploded in the sky. Can you make them all burn up or miss?';
    else advice = 'Every piece burned up or flew past. Earth is safe – amazing work, Commander!';
    if (clean) advice = 'You pushed the asteroid right past Earth without making a single dangerous piece. That is exactly how real planetary defenders hope to do it!';
    else if (G.level.goal === 'deflect' && stars < 3) advice += ' Remember: this one can be beaten without smashing anything – try slower impactors that push from the side, and push EARLY.';
    const hasNext = !G.level.isSandbox && G.level.idx + 1 < ED.LEVELS.length && levelUnlocked(G.level.idx + 1);
    const pct = Math.min(100, s.damage);
    openModal(
      `<div class="results">
        <h2>${titles[stars]}</h2>
        <div class="big-stars">${[0, 1, 2].map((i) => `<i class="${i < stars ? 'on' : ''}" style="animation-delay:${0.2 + i * 0.25}s">★</i>`).join('')}</div>
        <div class="res-grid">${rows}</div>
        <div class="dmg"><span>Earth damage</span><div class="dmg-bar"><div class="fill ${s.ground ? 'bad' : s.damage > 14 ? 'warn2' : s.damage > 3 ? 'warn' : 'ok'}" style="width:${pct}%"></div></div></div>
        ${s.largest ? `<p class="muted">Biggest piece to reach the atmosphere: <b>${Math.round(s.largest)} m</b></p>` : ''}
        <div class="advice">💡 ${esc(advice)}</div>
        <div class="row wrap">
          <button class="btn primary" data-act="retry">↺ Try again <small>(keep my plan)</small></button>
          <button class="btn" data-act="fresh">🧹 Start fresh</button>
          ${hasNext ? '<button class="btn go" data-act="next">Next mission ▶</button>' : ''}
          <span class="grow"></span>
          <button class="btn" data-act="book" data-back="results">📖 Logbook</button>
          <button class="btn" data-act="${G.level.isSandbox ? 'sandbox' : 'missions'}">${G.level.isSandbox ? '🧪 Sandbox' : '🗺️ Missions'}</button>
        </div>
      </div>`,
      'results-modal'
    );
    if (stars > 0) {
      audio.play('win');
      for (let i = 0; i < stars; i++) setTimeout(() => audio.play('star'), 300 + i * 250);
    } else audio.play('fail');
  }

  function showHelp(back) {
    const O = ED.OUTCOMES;
    openModal(
      `<h2>❓ How to play</h2>
      <ol class="steps">
        <li><span class="s-ico">🚀</span><div><b>Pick a penetrator</b> from the bar at the bottom: a <span class="kin">Kinetic Impactor</span> (a heavy, super-fast spacecraft) or a <span class="nuk">Nuclear Penetrator</span>.</div></li>
        <li><span class="s-ico">📍</span><div><b>${tap(1)} in the green zone</b> to place it – or drag it straight from the bar. It automatically aims at the asteroid. You can have up to 10 in your swarm.</div></li>
        <li><span class="s-ico">🎯</span><div>The dotted line shows its path and <b>✕</b> shows where it will hit. <b>${tap(1)} on the asteroid</b> to choose a target spot, or <b>drag the white handle</b> to change direction and speed. Drag a penetrator itself to move it.</div></li>
        <li><span class="s-ico">➕</span><div><b>Add follower</b> lines one penetrator up right behind another – great for digging deep holes!</div></li>
        <li><span class="s-ico">☢️</span><div>Nukes have a <b>fuse</b>: 🖐️ Manual (you press DETONATE), 📡 Standoff, 💥 Contact or ⛏️ Deep.</div></li>
        <li><span class="s-ico">⏱️</span><div><b>Launch delay</b> makes a penetrator wait before it launches – perfect for a second wave that hunts down big pieces.</div></li>
        <li><span class="s-ico">🔮</span><div>The <b>Mission computer</b> slider shows where the asteroid and its pieces will be in the future. Select a penetrator, slide to the moment you want, then ${tap()} a piece to hunt it!</div></li>
        <li><span class="s-ico">↗️</span><div>You don’t always have to smash! A <b>push from the side</b> can make an asteroid miss Earth completely. Slow impactors push without smashing – and the earlier you push, the better.</div></li>
        <li><span class="s-ico">🔥</span><div>Press <b>LAUNCH!</b> and watch what happens to every piece.</div></li>
      </ol>
      <h3>What happens to the pieces?</h3>
      <table class="outcomes">
        <tr><td>${O.burn.icon}</td><td><b>Smaller than ~15 m</b></td><td>${O.burn.blurb}</td></tr>
        <tr><td>${O.small.icon}</td><td><b>15 – 30 m</b></td><td>${O.small.blurb}</td></tr>
        <tr><td>${O.big.icon}</td><td><b>30 – 80 m</b></td><td>${O.big.blurb}</td></tr>
        <tr><td>${O.ground.icon}</td><td><b>Bigger than 80 m</b></td><td>${O.ground.blurb}</td></tr>
        <tr><td>${O.miss.icon}</td><td><b>Any size</b></td><td>Pieces pushed sideways can miss Earth completely!</td></tr>
      </table>
      <p class="muted small">Sizes are for rock. Iron survives the atmosphere much better (it counts as bigger), while fluffy stuff and rubble burn up more easily.</p>
      ${touchUI.on
        ? '<h3>Touch tips</h3><p class="muted small">Tap a penetrator to see its controls (🗑 removes it) · tap a flying 🖐️ manual nuke, or the big red button, to set it off · tap the score icons at the top to see what they mean · ⛶ goes full screen.</p>'
        : '<h3>Keys</h3><p class="muted small"><b>1</b>/<b>2</b> pick impactor / nuke · <b>Space</b> launch / detonate · <b>Delete</b> remove selected · right-click removes a penetrator · <b>Esc</b> deselect</p>'}
      <div class="row"><span class="grow"></span><button class="btn primary" data-act="${back === 'title' ? 'title' : 'close'}">Got it!</button></div>`,
      'help-modal'
    );
  }

  function showBook(focus, back) {
    const cards = ED.FACT_ORDER.map((id) => {
      const f = ED.FACTS[id];
      const got = save.facts.includes(id);
      return got
        ? `<div class="fact ${id === focus ? 'focus' : ''}" id="fact-${id}"><div class="f-ico">${f.icon}</div><div><h4>${esc(f.title)}</h4><p>${esc(f.text)}</p></div></div>`
        : `<div class="fact locked"><div class="f-ico">🔒</div><div><h4>???</h4><p>Keep playing to discover this one!</p></div></div>`;
    }).join('');
    let backAct = 'close';
    if (back === 'title') backAct = 'title';
    else if (back === 'results') backAct = 'back-results';
    else if (back === 'brief') backAct = 'level';
    const m = openModal(
      `<h2>📖 Science logbook <span class="badge">${save.facts.length}/${ED.FACT_ORDER.length}</span></h2>
      <p class="muted">Real space science you have discovered while defending Earth.</p>
      <div class="facts">${cards}</div>
      <div class="row"><span class="grow"></span><button class="btn primary" data-act="${backAct}" data-level="${G.levelIdx}">Close</button></div>`,
      'book-modal'
    );
    if (focus) {
      const el = m.querySelector('#fact-' + focus);
      if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    }
  }

  function showPause() {
    openModal(
      `<h2>⏸️ Paused</h2>
      <div class="menu-buttons">
        <button class="btn primary" data-act="resume">▶ Resume</button>
        ${G.level && !G.level.isSandbox ? '<button class="btn" data-act="fresh">🧹 Restart mission</button><button class="btn" data-act="missions">🗺️ Missions</button>' : '<button class="btn" data-act="sandbox">🧪 Sandbox setup</button>'}
        <button class="btn" data-act="title">🏠 Main menu</button>
      </div>`,
      'pause-modal'
    );
  }

  function showSandbox() {
    G.mode = 'menu';
    updateUI();
    const c = G.sandboxCfg;
    const opt = (key, val, label) => `<button class="opt ${c[key] === val ? 'on' : ''}" data-act="sb" data-key="${key}" data-val="${val}">${label}</button>`;
    const types = Object.entries(ED.ASTEROID_TYPES).map(([k, T]) => opt('type', k, `${T.icon} ${T.name}`)).join('');
    openModal(
      `<h2>🧪 Sandbox</h2><p class="muted">Build any asteroid you like and experiment!</p>
      <div class="sb-group"><h3>Asteroid type</h3><div class="opts">${types}</div></div>
      <div class="sb-group"><h3>Size</h3><div class="opts">${opt('size', 'small', 'Small · 120 m')}${opt('size', 'medium', 'Medium · 240 m')}${opt('size', 'large', 'Large · 400 m')}</div></div>
      <div class="sb-group"><h3>Heading for…</h3><div class="opts">${opt('path', 'high', '⬆ Top of Earth')}${opt('path', 'middle', '⏺ Middle')}${opt('path', 'low', '⬇ Bottom of Earth')}</div></div>
      <div class="sb-group"><h3>Speed</h3><div class="opts">${opt('speed', 'slow', '🐢 Slow')}${opt('speed', 'normal', '🚶 Normal')}${opt('speed', 'fast', '🏃 Fast')}</div></div>
      <div class="sb-group"><h3>Your swarm (up to ${MAX_SWARM})</h3>
        <div class="steppers">
          <div class="stepper kin">🚀 Kinetic <button data-act="sb" data-key="kinetic" data-val="-1">−</button><b>${c.kinetic}</b><button data-act="sb" data-key="kinetic" data-val="1">+</button></div>
          <div class="stepper nuk">☢️ Nuclear <button data-act="sb" data-key="nuke" data-val="-1">−</button><b>${c.nuke}</b><button data-act="sb" data-key="nuke" data-val="1">+</button></div>
        </div>
      </div>
      <div class="row"><button class="btn" data-act="title">← Back</button><span class="grow"></span><button class="btn primary big" data-act="sb-start">Start ▶</button></div>`,
      'sandbox-modal'
    );
  }

  function startSandbox() {
    const c = G.sandboxCfg;
    if (c.kinetic + c.nuke === 0) {
      toast('Add at least one penetrator to your swarm!');
      return;
    }
    c.seed = (c.seed * 7 + 13) % 997;
    const size = ED.SANDBOX_SIZES[c.size];
    const y = { high: 260, middle: 360, low: 460 }[c.path];
    const aimDY = { high: -150, middle: 0, low: 150 }[c.path];
    const speed = { slow: 52, normal: 68, fast: 88 }[c.speed];
    const level = {
      name: 'Sandbox',
      isSandbox: true,
      asteroids: [Object.assign({ type: c.type, seed: c.seed, x: 1100, y, speed, aimX: E.x, aimY: E.y + aimDY, spin: 0.08, elong: c.type === 'rubble' ? 0.2 : 0 }, size)],
      inventory: { kinetic: c.kinetic, nuke: c.nuke },
      briefing: '',
      tip: 'Experiment! Try different layouts, fuses and angles.',
      facts: [],
    };
    unlock(ED.ASTEROID_TYPES[c.type].fact, true);
    startLevel(level, false);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  updateBookBadge();
  showTitle();
  requestAnimationFrame(frame);

  // expose for debugging/testing
  ED.game = { G, startLevel, levelFromIndex, launch, placePen, showBriefing, finishRun };
})();
