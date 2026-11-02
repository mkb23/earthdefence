// Tiny synthesised sound effects with WebAudio (no sound files needed).
(function () {
  const ED = window.ED;

  const A = {
    ctx: null,
    master: null,
    noise: null,
    on: ED.util.store.get('earthdefence.sound', true),
    last: {},

    init() {
      if (this.ctx) {
        if (this.ctx.state !== 'running') {
          this.ctx.resume();
          this.unlock();
        }
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch (e) {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.on ? 0.55 : 0;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.unlock();
    },

    // iPad/iPhone Safari only starts sound after a silent sound is played during a touch
    unlock() {
      try {
        const s = this.ctx.createBufferSource();
        s.buffer = this.ctx.createBuffer(1, 1, 22050);
        s.connect(this.ctx.destination);
        s.start(0);
      } catch (e) {
        /* ignore */
      }
    },

    toggle() {
      this.on = !this.on;
      ED.util.store.set('earthdefence.sound', this.on);
      if (this.master) this.master.gain.value = this.on ? 0.55 : 0;
      return this.on;
    },

    env(g, t0, a, peak, dur) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    },

    tone(type, f0, f1, dur, vol, delay) {
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      this.env(g, t, 0.01, vol, dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.05);
    },

    hiss(filter, f0, f1, q, dur, vol, delay) {
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const s = c.createBufferSource();
      s.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = filter;
      f.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      f.Q.value = q;
      const g = c.createGain();
      this.env(g, t, 0.008, vol, dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t, Math.random()); s.stop(t + dur + 0.05);
    },

    play(name) {
      if (!this.ctx || !this.on) return;
      const now = performance.now();
      const gap = { burn: 70, crack: 60, small: 120, impact: 60, place: 40 }[name] || 0;
      if (gap && now - (this.last[name] || 0) < gap) return;
      this.last[name] = now;
      switch (name) {
        case 'click': this.tone('sine', 880, 880, 0.06, 0.12); break;
        case 'place': this.tone('triangle', 420, 880, 0.12, 0.2); break;
        case 'remove': this.tone('triangle', 600, 240, 0.14, 0.18); break;
        case 'select': this.tone('sine', 660, 990, 0.07, 0.12); break;
        case 'launch':
          this.hiss('bandpass', 300, 2400, 1.2, 0.9, 0.5);
          this.tone('sawtooth', 110, 220, 0.6, 0.06);
          break;
        case 'impact':
          this.hiss('lowpass', 2400, 200, 0.7, 0.6, 0.8);
          this.tone('sine', 140, 40, 0.5, 0.6);
          break;
        case 'nuke':
          this.hiss('lowpass', 6000, 300, 0.5, 0.35, 0.9);
          this.hiss('lowpass', 900, 60, 0.6, 3.2, 0.9, 0.05);
          this.tone('sine', 70, 28, 3.0, 0.9);
          break;
        case 'push': this.hiss('highpass', 1200, 3000, 0.7, 0.5, 0.25); break;
        case 'burn': this.hiss('highpass', 3000, 6000, 0.8, 0.25, 0.08); break;
        case 'small':
          this.hiss('lowpass', 1500, 250, 0.7, 0.6, 0.35);
          this.tone('sine', 110, 50, 0.4, 0.25);
          break;
        case 'big':
          this.hiss('lowpass', 1200, 100, 0.7, 1.3, 0.7);
          this.tone('sine', 80, 30, 1.2, 0.6);
          break;
        case 'ground':
          this.hiss('lowpass', 800, 50, 0.7, 2.6, 1.0);
          this.tone('sine', 55, 22, 2.4, 1.0);
          break;
        case 'star':
          [784, 988, 1175].forEach((f, i) => this.tone('triangle', f, f, 0.35, 0.18, i * 0.12));
          break;
        case 'win':
          [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.4, 0.18, i * 0.1));
          break;
        case 'fail':
          [392, 330, 262].forEach((f, i) => this.tone('square', f, f * 0.98, 0.3, 0.07, i * 0.18));
          break;
        case 'slowmo': this.tone('sine', 300, 120, 0.5, 0.15); break;
        case 'fact': this.tone('sine', 1200, 1600, 0.12, 0.08); this.tone('sine', 1600, 2000, 0.12, 0.06, 0.1); break;
        case 'crushed': this.hiss('bandpass', 800, 300, 3, 0.2, 0.4); break;
      }
    },
  };

  ED.Audio = A;
})();
