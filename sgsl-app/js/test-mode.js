/* ============================================================
   SgSL — Test: sign→text scoring (camera-on)
   ============================================================
   The app prompts a target sign; the user performs it; AutoCut segments
   the attempt; recognition (normalize → DTW → nearest-template) scores it
   against the reference and returns grade + per-part feedback.

   Reference templates: schema-v2 recordings (frames carry `pose` + `t`)
   score placement AND handshape; v1 hand-only recordings have no body
   frame, so recognition falls back to handshape-only scoring for them —
   every sign in the library is testable.
   ============================================================ */

import { TrackingCore } from './tracking-core.js';
import { AutoCut, trimFrames } from './autocut.js';
import { verifyAgainstTarget } from './recognition.js';
import { createAutoTuner } from './autotune-driver.js';
import { applySolvedOrientation, configureRetarget } from './calib-profile.js';
import * as signsSource from './signs-source.js';

// Median shoulder frame from an attempt's pose stream (the live calibration a scorer needs).
function calibFromFrames(frames) {
  const S = [];
  for (const f of frames) {
    const p = f.pose, L = p?.[11], R = p?.[12];
    if (L && R && (L[3] ?? 1) >= 0.5 && (R[3] ?? 1) >= 0.5) {
      S.push([(L[0] + R[0]) / 2, (L[1] + R[1]) / 2, Math.hypot(L[0] - R[0], L[1] - R[1])]);
    }
  }
  if (!S.length) return null;
  const med = (i) => S.map(s => s[i]).sort((a, b) => a - b)[Math.floor(S.length / 2)];
  return { shoulderMid: [med(0), med(1)], shoulderWidth: med(2) };
}
const isTestable = (rec) => !!(rec && Array.isArray(rec.landmarks)
  && rec.landmarks.some(f => f && (f.pose || f.rightHand || f.leftHand)));

export class TestController {
  constructor({ viewportId, videoId, overlayId = null, statusId, onResult = () => {} }) {
    this.viewportId = viewportId; this.videoId = videoId; this.overlayId = overlayId; this.statusId = statusId; this.onResult = onResult;
    this.core = null;
    this.templates = [];       // [{label, frames, calibration}]
    this.target = null;
    this.capturing = false;
    this._buf = [];
    this._cut = null;
    this._start = 0;
    this._level = 'normal';     // scoring strictness: easy | normal | strict
    this._tuner = null;         // hand-calibration driver while active
    this.onCalibrating = () => {};   // (active:boolean) — UI sync hook
  }

  /** Set scoring strictness (the "allowance for deviation" knob). */
  setStrictness(level) { this._level = level; }

  /** Toggle guided hand calibration (auto-tune) on the live Test mirror. Aligns the
   *  avatar's fingers/palm with the signer's — the SCORE always reads the raw camera,
   *  so this is about trusting what you see, not inflating the grade. */
  toggleHandCalibration() {
    if (this._tuner) {
      this._tuner.cancel(); this._tuner = null;
      this.onCalibrating(false);
      this._status('Hand calibration cancelled.', 'info');
      return;
    }
    if (!this.core) { this._status('Start the camera first.', 'error'); return; }
    this._tuner = createAutoTuner({
      retarget: this.core.retarget,
      onStatus: (m) => this._status(m, 'loading'),
      onSolved: (side, tuned) => {
        applySolvedOrientation(side, tuned);
        configureRetarget(this.core.retarget, {});   // re-apply device tuning to the mirror
      },
      onDone: () => {
        this._tuner = null;
        this.onCalibrating(false);
        this._status('Both hands calibrated — the mirror avatar now follows your fingers. Pick a sign and test yourself.', 'success');
      },
      onError: (m, { retrying }) => {
        if (!retrying) { this._tuner = null; this.onCalibrating(false); }
        this._status(m, 'error');
      },
    });
    this.onCalibrating(true);
  }
  get calibrating() { return !!this._tuner; }

  _status(m, t = 'info') { const el = document.getElementById(this.statusId); if (el) { el.textContent = m; el.className = `status status-${t}`; } }

  /** Build the testable-sign set (schema-v2 references). Returns the label list. */
  async loadTemplates() {
    const manifest = await signsSource.getManifest().catch(() => []);
    const out = [];
    for (const s of manifest) {
      const rec = await signsSource.getSign(s.label).catch(() => null);
      if (isTestable(rec)) out.push({ label: s.label, frames: rec.landmarks, calibration: rec.calibration || calibFromFrames(rec.landmarks) });
    }
    this.templates = out;
    return out.map(t => t.label);
  }

  async start() {
    this.core = new TrackingCore({
      videoId: this.videoId, viewportId: this.viewportId, overlayId: this.overlayId,
      onFrame: (results, frame) => this._onFrame(results, frame),
      onStatus: (m) => this._status(m, 'loading'),
    });
    const ok = await this.core.start();
    this._status(ok ? 'Camera ready — check your hand skeleton is tracking, pick a sign, then press "Sign the word".' : 'Camera/tracking failed.', ok ? 'info' : 'error');
    return ok;
  }

  setTarget(label) { this.target = label; }

  beginAttempt() {
    if (!this.target) { this._status('Pick a sign to practice first.', 'error'); return; }
    if (this._tuner) { this._tuner.cancel(); this._tuner = null; this.onCalibrating(false); }
    this._buf = []; this._cut = new AutoCut(); this._start = performance.now(); this.capturing = true;
    this._status(`Sign "${this.target}" now…`, 'loading');
  }

  /** Manual stop (also auto-stops via AutoCut). */
  endAttempt() { if (this.capturing) this._finish(); }

  _onFrame(results, frame) {
    this._tuner?.feed(results);
    if (!this.capturing) return;
    frame.t = performance.now() - this._start;
    this._buf.push(frame);
    const v = this._cut.update(frame);
    if (v.shouldStop) this._finish();
  }

  _finish() {
    this.capturing = false;
    const frames = trimFrames(this._buf);
    if (!frames || frames.length < 5) { this._status('Attempt too short — try again.', 'error'); return; }
    // Shoulder frame if visible. Missing shoulders only matter when the target
    // reference scores LOCATION (v2, body-framed): silently dropping the loc
    // channel there would grade a right handshape in the wrong place as perfect.
    // Hand-only (v1) references never score location — don't hard-reject those.
    const calib = calibFromFrames(frames);
    const target = this.templates.find(t => t.label === this.target);
    const targetScoresLoc = !!(target && (target.calibration || target.frames?.some(f => f?.pose)));
    if (!calib && targetScoresLoc) { this._status('Could not see your shoulders — step back so your upper body is in frame, and try again.', 'error'); return; }
    const verdict = verifyAgainstTarget(frames, calib, this.target, this.templates, this._level);
    this._status(`${verdict.pass ? '✅' : '❌'} ${this.target}: ${verdict.grade} (${verdict.score}/100)`, verdict.pass ? 'success' : 'error');
    this.onResult(verdict);
  }

  stop() {
    this.capturing = false;
    if (this._tuner) { this._tuner.cancel(); this._tuner = null; this.onCalibrating(false); }
    this.core?.stop(); this.core = null;
  }
}
