/* ============================================================
   SgSL Avatar — Quality Gate + Live Framing Scorer
   ============================================================
   - `framingScore(poseLandmarks)`: stateless per-frame scorer,
     used by the recorder's live gate (user must pass before the
     Record button is enabled).
   - `QualityGate.analyze(frames)`: post-recording report that
     reuses the same framing scorer for consistency.
   ============================================================ */

// Target framing, in normalized-frame coordinates (MediaPipe 0..1).
// These are intentionally lenient so a typical laptop-webcam crop
// (tight on head + shoulders, hands below mid-frame until raised)
// can pass. We only reject cases where detection is so bad that
// retargeting quality collapses: no body, no centering, or signer
// jammed against the lens.
const FRAMING_TARGETS = {
  headCxMin: 0.30, headCxMax: 0.70,           // horizontal center band
  shoulderMidYMax: 0.90,                       // shoulders not below frame
  shoulderWidthMax: 0.60,                      // signer not touching lens
};

/**
 * Evaluate framing for a single MediaPipe pose landmarks array.
 * Returns { ok, score (0..1), reasons[] }.
 */
export function framingScore(poseLandmarks) {
  if (!poseLandmarks || poseLandmarks.length < 13) {
    return { ok: false, score: 0, reasons: ['No body detected — step into frame'] };
  }
  const nose = poseLandmarks[0];
  const ls = poseLandmarks[11];
  const rs = poseLandmarks[12];
  if (!nose || !ls || !rs) {
    return { ok: false, score: 0.2, reasons: ['Head and shoulders must be visible'] };
  }

  const reasons = [];
  const headCx = nose.x;
  const shoulderMidY = (ls.y + rs.y) / 2;
  const shoulderWidth = Math.abs(ls.x - rs.x);

  const checks = [
    { ok: headCx >= FRAMING_TARGETS.headCxMin && headCx <= FRAMING_TARGETS.headCxMax,
      msg: headCx < FRAMING_TARGETS.headCxMin ? 'Move right' : 'Move left' },
    { ok: shoulderMidY <= FRAMING_TARGETS.shoulderMidYMax,
      msg: 'Raise the camera a bit — shoulders are off the bottom' },
    { ok: shoulderWidth <= FRAMING_TARGETS.shoulderWidthMax,
      msg: 'Move back slightly — too close to the camera' },
  ];

  let passed = 0;
  for (const c of checks) {
    if (c.ok) passed++; else reasons.push(c.msg);
  }
  const score = passed / checks.length;
  return { ok: passed === checks.length, score, reasons };
}

export class QualityGate {
  static analyze(frames) {
    if (!frames || !frames.length) {
      return { overall: 0, grade: 'F', pass: false, details: {}, message: 'No frames recorded.' };
    }

    // Duration from real timestamps (schema v2), else fall back.
    const duration = (frames[frames.length - 1].t && frames[0].t !== undefined)
      ? ((frames[frames.length - 1].t - frames[0].t) / 1000)
      : (frames.length / 30);

    const details = {
      frameCount: frames.length,
      duration: duration.toFixed(1) + 's',
      rightHand: this._analyzeChannel(frames, 'rightHand', 21),
      leftHand:  this._analyzeChannel(frames, 'leftHand', 21),
      pose:      this._analyzeChannel(frames, 'pose', 33),
      face:      this._analyzeChannel(frames, 'face', 478),
      jitter:    this._analyzeJitter(frames),
      framing:   this._analyzeFraming(frames),
    };

    const weights = {
      rightHand: 0.25, leftHand: 0.10, pose: 0.30,
      face: 0.10, jitter: 0.15, framing: 0.10,
    };
    let overall = 0;
    for (const [key, weight] of Object.entries(weights)) {
      overall += (details[key]?.score ?? 0) * weight;
    }
    if (details.rightHand.completeness > 0.5 && details.leftHand.completeness > 0.5) {
      overall = Math.min(1, overall + 0.05);
    }

    const grade = overall >= 0.85 ? 'A' : overall >= 0.7 ? 'B' : overall >= 0.5 ? 'C' : overall >= 0.3 ? 'D' : 'F';
    const pass = overall >= 0.5;

    const issues = [];
    if (details.pose.completeness < 0.5) issues.push('Pose landmarks missing in many frames — ensure full upper body is visible');
    if (details.rightHand.completeness < 0.3 && details.leftHand.completeness < 0.3) issues.push('No hands detected — check lighting and hand visibility');
    if (details.jitter.score < 0.5) issues.push('High jitter detected — try steadier movements or better lighting');
    if (details.framing.score < 0.5) issues.push('Poor framing — center yourself in the camera');
    if (frames.length < 10) issues.push('Too few frames — hold the sign longer');

    return {
      overall: Math.round(overall * 100),
      grade,
      pass,
      details,
      issues,
      message: pass
        ? `Quality: ${grade} (${Math.round(overall * 100)}%)`
        : `Quality too low: ${grade} (${Math.round(overall * 100)}%). ${issues[0] || 'Try again.'}`,
    };
  }

  static _analyzeChannel(frames, channel, expectedPoints) {
    let present = 0;
    let totalConfidence = 0;
    let confCount = 0;

    for (const frame of frames) {
      const data = frame[channel];
      if (data && Array.isArray(data) && data.length >= Math.floor(expectedPoints * 0.5)) {
        present++;
        for (const pt of data) {
          if (pt && pt.length >= 4) {
            totalConfidence += pt[3];
            confCount++;
          }
        }
      }
    }

    const completeness = present / frames.length;
    const avgConfidence = confCount > 0 ? totalConfidence / confCount : (completeness > 0 ? 0.7 : 0);
    const score = completeness * 0.6 + avgConfidence * 0.4;

    return {
      completeness: Math.round(completeness * 100) / 100,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      framesPresent: present,
      framesTotal: frames.length,
      score: Math.round(score * 100) / 100,
    };
  }

  static _analyzeJitter(frames) {
    // Average inter-frame landmark delta on right hand.
    // Good: < 0.01 per frame. Bad: > 0.05 per frame.
    let totalJitter = 0;
    let jitterCount = 0;

    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].rightHand;
      const curr = frames[i].rightHand;
      if (prev && curr && prev.length >= 21 && curr.length >= 21) {
        let frameJitter = 0;
        for (let p = 0; p < 21; p++) {
          const dx = curr[p][0] - prev[p][0];
          const dy = curr[p][1] - prev[p][1];
          frameJitter += Math.sqrt(dx * dx + dy * dy);
        }
        totalJitter += frameJitter / 21;
        jitterCount++;
      }
    }

    if (jitterCount === 0) return { avgJitter: 0, score: 0 };

    const avgJitter = totalJitter / jitterCount;
    const score = Math.max(0, Math.min(1, 1 - (avgJitter - 0.005) / 0.04));
    return {
      avgJitter: Math.round(avgJitter * 1000) / 1000,
      score: Math.round(score * 100) / 100,
    };
  }

  static _analyzeFraming(frames) {
    // Reuse the live framing scorer so record-time and post-hoc
    // scores agree. Treat each frame's pose as a MediaPipe-style
    // array of {x,y,...} landmarks.
    let sum = 0, n = 0;
    for (const frame of frames) {
      const pose = frame.pose;
      if (!pose || pose.length < 13) continue;
      const lms = pose.map(p => ({ x: p[0], y: p[1] }));
      sum += framingScore(lms).score;
      n++;
    }
    if (!n) return { score: 0.3 };
    const score = sum / n;
    return { score: Math.round(score * 100) / 100 };
  }
}
