/**
 * SgSL Studio — application glue.
 * Wires the avatar, classifier, tracker and dictionary into four modes:
 * lookup (word → sign), read (sign → word), practice, and alphabet reference.
 */

import { Avatar } from "./avatar.js";
import { classify, Smoother, MAX_DIST } from "./classifier.js";
import { Tracker } from "./tracker.js";
import { DICTIONARY, lookupWord, suggest } from "./dictionary.js";
import { LETTER_POSES, STATIC_LETTERS } from "./poses.js";

const $ = (id) => document.getElementById(id);

/* ---------------- tabs ---------------- */
const tabs = document.querySelectorAll(".tab");
tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    document
      .querySelectorAll(".panel")
      .forEach((p) =>
        p.classList.toggle("active", p.id === `panel-${tab.dataset.panel}`)
      );
    if (tab.dataset.panel !== "read" && readTracker.running) stopRead();
    if (tab.dataset.panel !== "practice" && practiceTracker.running)
      stopPractice();
  })
);

/* ---------------- lookup mode ---------------- */
const avatar = new Avatar($("avatar-canvas"));
let lastSpelled = "";

avatar.onLetter = (l) => {
  $("spelled-so-far").textContent += l;
};

function doLookup(text) {
  const clean = text.trim();
  if (!clean) return;
  lastSpelled = clean;
  $("spelled-so-far").textContent = "";
  const entry = lookupWord(clean);
  const card = $("lookup-card");
  if (entry) {
    $("lookup-word").textContent = entry.word.toUpperCase();
    $("lookup-desc").textContent = entry.description;
    card.classList.remove("hidden");
  } else {
    $("lookup-word").textContent = clean.toUpperCase();
    $("lookup-desc").textContent =
      "Not in the built-in dictionary yet — the avatar will fingerspell it letter by letter.";
    card.classList.remove("hidden");
  }
  avatar.spell(clean);
}

$("lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doLookup($("lookup-input").value);
});
$("replay-btn").addEventListener("click", () => {
  if (lastSpelled) {
    $("spelled-so-far").textContent = "";
    avatar.spell(lastSpelled);
  }
});
$("speed-sel").addEventListener("change", (e) => {
  avatar.speed = parseFloat(e.target.value);
});

// Chips for every dictionary word
const knownBox = $("lookup-known");
for (const e of DICTIONARY) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = e.word;
  chip.addEventListener("click", () => {
    $("lookup-input").value = e.word;
    doLookup(e.word);
  });
  knownBox.appendChild(chip);
}

/* ---------------- read mode (sign → text) ---------------- */
const readTracker = new Tracker($("video"), $("overlay"));
const smoother = new Smoother();
let typed = "";

const RING_LEN = 2 * Math.PI * 24;
$("ring-fg").style.strokeDasharray = `${RING_LEN}`;
$("ring-fg").style.strokeDashoffset = `${RING_LEN}`;

function renderTyped() {
  $("typed").textContent = typed || " ";
  const lastWord = typed.split(" ").pop().toLowerCase();
  const box = $("suggestions");
  box.innerHTML = "";
  for (const e of suggest(lastWord)) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = e.word;
    chip.title = e.description;
    chip.addEventListener("click", () => {
      const parts = typed.split(" ");
      parts[parts.length - 1] = e.word.toUpperCase();
      typed = parts.join(" ") + " ";
      renderTyped();
    });
    box.appendChild(chip);
  }
}

readTracker.onFrame = (lms) => {
  let top = null;
  let ranked = [];
  if (lms) {
    ranked = classify(lms);
    if (ranked.length && ranked[0].dist <= MAX_DIST) top = ranked[0].letter;
  }
  const { stable, progress, committed } = smoother.push(top);

  $("live-letter").textContent = stable || "–";
  $("ring-fg").style.strokeDashoffset = `${RING_LEN * (1 - progress)}`;

  const box = $("candidates");
  box.innerHTML = "";
  for (const r of ranked.slice(0, 3)) {
    const div = document.createElement("div");
    div.className = "cand";
    div.innerHTML = `<span>${r.letter}</span><div class="bar"><div style="width:${Math.round(
      r.score * 100
    )}%"></div></div>`;
    box.appendChild(div);
  }

  if (committed) {
    typed += committed;
    renderTyped();
  }
};

async function startRead() {
  $("cam-btn").disabled = true;
  try {
    await readTracker.start((msg) => ($("cam-status").textContent = msg));
    $("cam-status").textContent = "";
    $("cam-status").classList.add("hidden");
    $("cam-btn").textContent = "Stop camera";
  } catch (err) {
    $("cam-status").textContent = `Could not start: ${err.message}`;
  }
  $("cam-btn").disabled = false;
}
function stopRead() {
  readTracker.stop();
  smoother.reset();
  $("cam-btn").textContent = "Start camera";
  $("cam-status").textContent = "Camera off";
  $("cam-status").classList.remove("hidden");
}
$("cam-btn").addEventListener("click", () =>
  readTracker.running ? stopRead() : startRead()
);
$("space-btn").addEventListener("click", () => {
  if (typed && !typed.endsWith(" ")) typed += " ";
  renderTyped();
});
$("backspace-btn").addEventListener("click", () => {
  typed = typed.slice(0, -1);
  renderTyped();
});
$("clear-btn").addEventListener("click", () => {
  typed = "";
  renderTyped();
});

/* ---------------- practice mode ---------------- */
const practiceAvatar = new Avatar($("practice-avatar"));
const practiceTracker = new Tracker($("p-video"), $("p-overlay"));
let practiceTarget = null;
let practiceWord = "";
let practiceIdx = 0;
let streak = 0;
let score = 0;
let matchSince = null;
const MATCH_HOLD_MS = 900;

$("practice-mode").addEventListener("change", (e) => {
  $("practice-word").classList.toggle("hidden", e.target.value !== "word");
});

function nextTarget() {
  const mode = $("practice-mode").value;
  if (mode === "word") {
    // J and Z need motion, which live recognition can't verify yet — skip them.
    practiceWord = ($("practice-word").value || "hello")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .replace(/[JZ]/g, "");
    if (!practiceWord) practiceWord = "HELLO";
    if (practiceIdx >= practiceWord.length) practiceIdx = 0;
    practiceTarget = practiceWord[practiceIdx];
    $("practice-progress").textContent = practiceWord
      .split("")
      .map((c, i) => (i < practiceIdx ? c : i === practiceIdx ? `[${c}]` : c))
      .join(" ");
  } else {
    const pool = STATIC_LETTERS;
    let next;
    do {
      next = pool[Math.floor(Math.random() * pool.length)];
    } while (next === practiceTarget && pool.length > 1);
    practiceTarget = next;
    $("practice-progress").textContent = "";
  }
  $("practice-letter").textContent = practiceTarget;
  practiceAvatar.show(practiceTarget);
  matchSince = null;
  $("match-bar").style.width = "0%";
}

function advance() {
  score++;
  streak++;
  $("score").textContent = score;
  $("streak").textContent = streak;
  if ($("practice-mode").value === "word") {
    practiceIdx++;
    if (practiceIdx >= practiceWord.length) practiceIdx = 0;
  }
  nextTarget();
}

practiceTracker.onFrame = (lms) => {
  if (!practiceTarget) return;
  let match = false;
  if (lms) {
    const ranked = classify(lms);
    match =
      ranked.length &&
      ranked[0].letter === practiceTarget &&
      ranked[0].dist <= MAX_DIST;
  }
  const now = performance.now();
  if (match) {
    if (matchSince === null) matchSince = now;
    const p = Math.min(1, (now - matchSince) / MATCH_HOLD_MS);
    $("match-bar").style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) advance();
  } else {
    matchSince = null;
    $("match-bar").style.width = "0%";
    if (lms === null) return;
  }
};

async function startPractice() {
  $("practice-start").disabled = true;
  try {
    await practiceTracker.start(
      (msg) => ($("p-cam-status").textContent = msg)
    );
    $("p-cam-status").classList.add("hidden");
    $("practice-start").textContent = "Stop";
    practiceIdx = 0;
    streak = 0;
    $("streak").textContent = "0";
    nextTarget();
  } catch (err) {
    $("p-cam-status").textContent = `Could not start: ${err.message}`;
  }
  $("practice-start").disabled = false;
}
function stopPractice() {
  practiceTracker.stop();
  practiceTarget = null;
  $("practice-start").textContent = "Start practice";
  $("p-cam-status").textContent = "Camera off";
  $("p-cam-status").classList.remove("hidden");
  practiceAvatar.rest();
}
$("practice-start").addEventListener("click", () =>
  practiceTracker.running ? stopPractice() : startPractice()
);
$("practice-skip").addEventListener("click", () => {
  if (practiceTarget) {
    streak = 0;
    $("streak").textContent = "0";
    if ($("practice-mode").value === "word") {
      practiceIdx = (practiceIdx + 1) % practiceWord.length;
    }
    nextTarget();
  }
});

/* ---------------- alphabet reference ---------------- */
const alphaAvatar = new Avatar($("alpha-canvas"));
const grid = $("alpha-grid");
for (const letter of Object.keys(LETTER_POSES)) {
  const btn = document.createElement("button");
  btn.className = "alpha-cell" + (letter === "T" ? " special" : "");
  btn.textContent = letter;
  btn.addEventListener("click", () => {
    grid
      .querySelectorAll(".alpha-cell")
      .forEach((c) => c.classList.toggle("selected", c === btn));
    const pose = LETTER_POSES[letter];
    alphaAvatar.show(letter);
    $("alpha-letter").textContent = `Letter ${letter}`;
    $("alpha-desc").textContent = pose.desc || "";
    const note = $("alpha-note");
    if (pose.sgslNote) {
      note.textContent = pose.sgslNote;
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }
  });
  grid.appendChild(btn);
}
grid.querySelector(".alpha-cell").click();
