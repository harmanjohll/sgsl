/* ============================================================
   SgSL — Playback Engine
   ============================================================
   Drives sign playback on a VRM avatar. One reusable engine, used by
   both the Library tab (play a single sign) and the Sign-It tab (play a
   chained sentence) — so single-sign and sentence playback are pixel
   identical.

   - Real-timestamp-driven playback (no fixed-fps assumption)
   - Shared min-jerk interpolation (interp.js) — same math the recorder
     preview uses
   - Reads signs through signs-source.js (static library + IndexedDB)
   - Pause/resume/replay/speed; progress + completion callbacks

   A frame is { t, pose, poseWorld, face, leftHand, rightHand }; `t` is
   ms since sequence start. Legacy signs without `t` are backfilled at
   ~30 fps so they still play.
   ============================================================ */

import { SMPLXAvatar } from './avatar.js';
import { SMPLXRetarget } from './retarget.js';
import { lerpFrame } from './interp.js';
import * as signsSource from './signs-source.js';

export class Playback {
  constructor(viewportId) {
    this.avatar = new SMPLXAvatar(viewportId);
    this.retarget = new SMPLXRetarget();
    this.retarget.setVideo(null);     // playback has no camera feed
    this.retarget.setAvatar(this.avatar);

    this.seq = [];
    this.playing = false;
    this.paused = false;
    this.fi = 0;
    this.speed = 1;
    this.startWall = 0;
    this.startT = 0;
    this.rafId = null;
    this._cbs = {};
  }

  on(name, fn) { this._cbs[name] = fn; return this; }
  _emit(name, ...args) { if (this._cbs[name]) this._cbs[name](...args); }

  get ready() { return !!(this.avatar && this.avatar.loaded); }

  // ─── Frame -> avatar ──────────────────────────────────────
  renderFrame(frame) {
    if (!this.avatar?.vrm || !this.retarget || !frame) return;
    const toMP = (arr) => arr ? arr.map(p => ({
      x: p[0], y: p[1], z: p[2] ?? 0, visibility: p[3] ?? 1,
    })) : null;
    this.retarget.applyFromMediaPipe(this.avatar.vrm, {
      poseLandmarks: toMP(frame.pose),
      za: toMP(frame.poseWorld || frame.pose),
      faceLandmarks: toMP(frame.face),
      rightHandLandmarks: toMP(frame.rightHand),
      leftHandLandmarks: toMP(frame.leftHand),
    });
  }

  // ─── Play an explicit frame sequence ──────────────────────
  playFrames(frames) {
    const valid = (frames || []).filter(f => f && (f.pose || f.leftHand || f.rightHand));
    if (!valid.length) { this._emit('status', 'No valid frames.', 'error'); return false; }

    // Backfill timestamps if missing (legacy schema v1).
    const hasT = valid.every(f => typeof f.t === 'number');
    this.seq = hasT ? valid : valid.map((f, i) => ({ ...f, t: i * (1000 / 30) }));

    this.retarget.reset();
    this.fi = 0;
    this.playing = true;
    this.paused = false;
    this.avatar.setPlaying(true);
    this.startWall = performance.now();
    this.startT = this.seq[0].t;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this._tick();
    return true;
  }

  async playLabel(label) {
    this._emit('status', `Loading "${label}"...`, 'loading');
    try {
      const data = await signsSource.getSign(label);
      const ok = this.playFrames(data.landmarks || []);
      if (ok) {
        const durS = ((this.seq[this.seq.length - 1].t - this.seq[0].t) / 1000).toFixed(1);
        this._emit('status', `Playing "${label}" (${this.seq.length} frames, ${durS}s)`, 'info');
      }
    } catch (err) {
      this._emit('status', err.message, 'error');
    }
  }

  _currentTargetT() {
    return this.startT + (performance.now() - this.startWall) * this.speed;
  }

  _tick() {
    if (!this.playing || this.paused) return;
    const targetT = this._currentTargetT();
    const seq = this.seq;

    while (this.fi < seq.length - 2 && seq[this.fi + 1].t <= targetT) this.fi++;
    this._emit('progress', this.fi, seq.length);

    if (targetT >= seq[seq.length - 1].t) {
      this.renderFrame(seq[seq.length - 1]);
      this.playing = false;
      this.avatar.setPlaying(false);
      this._emit('done');
      this._emit('status', 'Playback complete.', 'success');
      return;
    }

    const a = seq[this.fi], b = seq[this.fi + 1];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(Math.max((targetT - a.t) / span, 0), 1);
    this.renderFrame(lerpFrame(a, b, u));
    this.rafId = requestAnimationFrame(() => this._tick());
  }

  togglePause() {
    if (!this.playing) return;
    if (!this.paused) {
      this.startT = this._currentTargetT();
      this.paused = true;
    } else {
      this.startWall = performance.now();
      this.paused = false;
      this._tick();
    }
    this._emit('pause', this.paused);
  }

  replay() {
    if (!this.seq.length) return;
    this.retarget.reset();
    this.fi = 0;
    this.paused = false;
    this.playing = true;
    this.avatar.setPlaying(true);
    this.startWall = performance.now();
    this.startT = this.seq[0].t;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this._tick();
  }

  stop() {
    this.playing = false;
    this.paused = false;
    if (this.avatar) this.avatar.setPlaying(false);
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  setSpeed(s) {
    if (this.playing && !this.paused) {
      // Rebase anchors so a mid-play speed change doesn't jump.
      this.startT = this._currentTargetT();
      this.startWall = performance.now();
    }
    this.speed = s;
  }
}
