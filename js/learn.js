/* ============================================================
   SgSL — Learn: guided lessons (text→sign, camera-off)
   ============================================================
   A lesson = an ordered list of sign labels. Flow: prompt a word →
   Fumi signs it (shared Playback) → "Got it" (mark known, advance) or
   "Practice" (replay). Progress + a light streak/XP live in
   localStorage. Signs not yet in the library are shown greyed and
   skipped — the lesson stays honest to the recorded vocabulary.
   ============================================================ */

import * as signsSource from './signs-source.js';

const KEY = 'sgsl.learn.v1';

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveProgress(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} }

// UTC day index — for a "practiced today" streak without a real clock dependency
// beyond the browser's (fine client-side).
function dayNum() { return Math.floor(Date.now() / 86400000); }

export class LearnController {
  constructor(playback, { statusId }) {
    this.pb = playback;
    this.statusId = statusId;
    this.lessons = [];
    this.available = new Set();
    this.current = null;   // { lesson, idx, signs:[{label,available}] }
    this.p = loadProgress();
    this.p.known ||= {}; this.p.xp ||= 0; this.p.streak ||= 0; this.p.lastDay ||= 0;
  }

  async load() {
    const [lessonsDoc, manifest] = await Promise.all([
      fetch(new URL('../lessons.json', import.meta.url)).then(r => r.json()).catch(() => ({ lessons: [] })),
      signsSource.getManifest().catch(() => []),
    ]);
    this.lessons = lessonsDoc.lessons || [];
    this.available = new Set(manifest.map(s => s.label.toLowerCase()));
  }

  _status(msg) { const el = document.getElementById(this.statusId); if (el) el.textContent = msg; }

  renderLessonList(containerEl, onPick) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    for (const lesson of this.lessons) {
      const avail = lesson.signs.filter(l => this.available.has(l.toLowerCase()));
      const known = avail.filter(l => this.p.known[l.toLowerCase()]).length;
      const card = document.createElement('button');
      card.className = 'lesson-card';
      card.innerHTML = `<span class="lesson-title">${lesson.title}</span>`
        + `<span class="lesson-sub">${lesson.blurb}</span>`
        + `<span class="lesson-prog">${known}/${lesson.signs.length} learned · ${avail.length} available</span>`;
      card.addEventListener('click', () => onPick(lesson.id));
      containerEl.appendChild(card);
    }
    this._renderXP();
  }

  _renderXP() {
    const el = document.getElementById('learn-xp');
    if (el) el.textContent = `⭐ ${this.p.xp} XP · 🔥 ${this.p.streak}-day streak`;
  }

  startLesson(id) {
    const lesson = this.lessons.find(l => l.id === id);
    if (!lesson) return null;
    const signs = lesson.signs.map(label => ({ label, available: this.available.has(label.toLowerCase()) }));
    this.current = { lesson, idx: -1, signs };
    return this.next();
  }

  /** Advance to the next AVAILABLE sign; returns the step (or null at lesson end). */
  next() {
    if (!this.current) return null;
    const s = this.current;
    do { s.idx++; } while (s.idx < s.signs.length && !s.signs[s.idx].available);
    if (s.idx >= s.signs.length) return this._finish();
    const step = s.signs[s.idx];
    this.pb.playLabel(step.label);
    this._status(`Watch: "${step.label}"  ·  sign ${s.idx + 1} of ${s.signs.length}`);
    return { label: step.label, index: s.idx, total: s.signs.length, done: false };
  }

  replay() { if (this.current && this.current.idx >= 0) this.pb.playLabel(this.current.signs[this.current.idx].label); }

  gotIt() {
    if (!this.current || this.current.idx < 0) return this.next();
    const label = this.current.signs[this.current.idx].label.toLowerCase();
    if (!this.p.known[label]) { this.p.known[label] = true; this.p.xp += 10; }
    this._bumpStreak();
    saveProgress(this.p); this._renderXP();
    return this.next();
  }

  _bumpStreak() {
    const d = dayNum();
    if (this.p.lastDay === d) return;
    this.p.streak = (this.p.lastDay === d - 1) ? this.p.streak + 1 : 1;
    this.p.lastDay = d;
  }

  _finish() {
    const c = this.current; this.current = null;
    this._status(`Lesson "${c.lesson.title}" complete! ⭐`);
    return { done: true, lesson: c.lesson.title };
  }
}
