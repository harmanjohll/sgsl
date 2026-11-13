/* ============================================================
   SgSL Hub — How It Works (ML Pipeline Explainer)
   ============================================================
   Interactive visualization showing how the AI recognizes signs.
   Populates the #how-it-works section with animated content.
   ============================================================ */

export function initHowItWorks() {
  const section = document.getElementById('how-it-works-content');
  if (!section) return;

  section.innerHTML = `
    <div class="hiw-hero">
      <h2>How Our AI Learns Sign Language</h2>
      <p>SgSL Hub uses machine learning to recognize hand signs in real time.
         Here's a look under the hood at how it all works.</p>
    </div>

    <!-- Pipeline Overview -->
    <div class="hiw-pipeline">
      <div class="hiw-step" data-step="1">
        <div class="hiw-step-icon">
          <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="8" y="10" width="24" height="20" rx="3"/>
            <path d="M32 17L40 12V28L32 23"/>
            <circle cx="20" cy="20" r="4" stroke-width="1.5"/>
          </svg>
        </div>
        <h3>1. Camera Capture</h3>
        <p>Your webcam captures video at ~30 frames per second. Each frame is sent to
           <strong>MediaPipe Holistic</strong>, a tracking AI by Google that detects
           both hands, face, and body pose — all directly in your browser.</p>
      </div>

      <div class="hiw-arrow">
        <svg viewBox="0 0 24 48" width="20" height="40"><path d="M12 4 L12 36 M6 30 L12 36 L18 30" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      </div>

      <div class="hiw-step" data-step="2">
        <div class="hiw-step-icon">
          <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="24" cy="12" r="3"/><circle cx="16" cy="24" r="2.5"/><circle cx="32" cy="24" r="2.5"/>
            <circle cx="12" cy="36" r="2"/><circle cx="24" cy="36" r="2"/><circle cx="36" cy="36" r="2"/>
            <line x1="24" y1="15" x2="16" y2="21.5"/><line x1="24" y1="15" x2="32" y2="21.5"/>
            <line x1="16" y1="26.5" x2="12" y2="34"/><line x1="16" y1="26.5" x2="24" y2="34"/>
            <line x1="32" y1="26.5" x2="36" y2="34"/>
          </svg>
        </div>
        <h3>2. Hand Landmarks</h3>
        <p>MediaPipe detects <strong>21 key points</strong> on your hand — wrist, each knuckle,
           and every fingertip. These are captured as 3D coordinates (x, y, z)
           at every frame. No images are stored, only these coordinates.</p>
        <div class="hiw-landmark-demo">
          <svg viewBox="0 0 200 200" class="hiw-hand-svg">
            <g class="hiw-hand-anim">
              <!-- Wrist -->
              <circle cx="100" cy="170" r="5" fill="var(--primary)"/>
              <!-- Palm -->
              <line x1="100" y1="170" x2="70" y2="120" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="70" y1="120" x2="50" y2="70" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="50" y1="70" x2="45" y2="40" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="70" y1="120" x2="80" y2="60" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="80" y1="60" x2="82" y2="30" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="70" y1="120" x2="100" y2="55" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="100" y1="55" x2="105" y2="28" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="70" y1="120" x2="120" y2="65" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="120" y1="65" x2="130" y2="40" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="100" y1="170" x2="140" y2="130" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="140" y1="130" x2="155" y2="100" stroke="var(--primary-light)" stroke-width="2"/>
              <line x1="155" y1="100" x2="165" y2="80" stroke="var(--primary-light)" stroke-width="2"/>
              <!-- Joints -->
              <circle cx="70" cy="120" r="4" fill="var(--primary)"/>
              <circle cx="50" cy="70" r="3" fill="var(--primary)"/>
              <circle cx="80" cy="60" r="3" fill="var(--primary)"/>
              <circle cx="100" cy="55" r="3" fill="var(--primary)"/>
              <circle cx="120" cy="65" r="3" fill="var(--primary)"/>
              <circle cx="140" cy="130" r="3" fill="var(--primary)"/>
              <circle cx="155" cy="100" r="3" fill="var(--primary)"/>
              <!-- Fingertips -->
              <circle cx="45" cy="40" r="5" fill="var(--primary-light)" class="hiw-pulse"/>
              <circle cx="82" cy="30" r="5" fill="var(--primary-light)" class="hiw-pulse"/>
              <circle cx="105" cy="28" r="5" fill="var(--primary-light)" class="hiw-pulse"/>
              <circle cx="130" cy="40" r="5" fill="var(--primary-light)" class="hiw-pulse"/>
              <circle cx="165" cy="80" r="5" fill="var(--primary-light)" class="hiw-pulse"/>
            </g>
            <!-- Labels -->
            <text x="100" y="192" text-anchor="middle" fill="var(--text-3)" font-size="10">Wrist</text>
            <text x="82" y="18" text-anchor="middle" fill="var(--text-3)" font-size="9">Fingertips</text>
          </svg>
          <div class="hiw-landmark-info">
            <div class="hiw-stat"><span class="hiw-stat-num">21</span><span>landmarks per frame</span></div>
            <div class="hiw-stat"><span class="hiw-stat-num">3</span><span>coordinates each (x, y, z)</span></div>
            <div class="hiw-stat"><span class="hiw-stat-num">~30</span><span>frames per second</span></div>
          </div>
        </div>
      </div>

      <div class="hiw-arrow">
        <svg viewBox="0 0 24 48" width="20" height="40"><path d="M12 4 L12 36 M6 30 L12 36 L18 30" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      </div>

      <div class="hiw-step" data-step="3">
        <div class="hiw-step-icon">
          <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="10" width="36" height="28" rx="3"/>
            <path d="M14 22h6M14 28h4M28 18v16M34 22v12" stroke-linecap="round"/>
          </svg>
        </div>
        <h3>3. Feature Extraction</h3>
        <p>Raw landmarks become a <strong>59-dimensional feature vector</strong> each frame:</p>
        <div class="hiw-features">
          <div class="hiw-feature-box">
            <span class="hiw-feat-num">48</span>
            <span>bone direction values — unit vectors along each finger segment,
                  making the features rotation- and scale-independent</span>
          </div>
          <div class="hiw-feature-box">
            <span class="hiw-feat-num">11</span>
            <span>distance values — pairwise fingertip distances plus
                  palm reference points, capturing hand shape</span>
          </div>
        </div>
        <p class="hiw-note">The features are normalized so signs look the same regardless
           of how close you are to the camera or the angle of your hand.</p>
      </div>

      <div class="hiw-arrow">
        <svg viewBox="0 0 24 48" width="20" height="40"><path d="M12 4 L12 36 M6 30 L12 36 L18 30" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      </div>

      <div class="hiw-step hiw-split" data-step="4">
        <h3>4. Dual Recognition Engine</h3>
        <p>Your sign is compared against the library using <strong>two independent methods</strong>,
           then results are combined for maximum accuracy:</p>
        <div class="hiw-dual">
          <div class="hiw-method">
            <div class="hiw-method-badge dtw">DTW</div>
            <h4>Dynamic Time Warping</h4>
            <p>Compares your sign <strong>frame by frame</strong> against every sign in the
               library. It can match signs performed at different speeds by warping the
               time axis — a fast "hello" matches a slow "hello".</p>
            <div class="hiw-method-detail">
              <span>Works from the very first contribution</span>
              <span>Handles variable-speed signs</span>
              <span>Compares full movement sequences</span>
            </div>
          </div>
          <div class="hiw-method">
            <div class="hiw-method-badge knn">k-NN</div>
            <h4>k-Nearest Neighbors</h4>
            <p>Resamples your sign to exactly <strong>32 frames</strong>, flattens it into
               a single 1,888-dimensional vector, then finds the 3 closest matches
               in the library using distance-weighted voting.</p>
            <div class="hiw-method-detail">
              <span>Improves with more contributions</span>
              <span>Normalizes sign length to 32 frames</span>
              <span>Votes on best match with confidence</span>
            </div>
          </div>
        </div>
      </div>

      <div class="hiw-arrow">
        <svg viewBox="0 0 24 48" width="20" height="40"><path d="M12 4 L12 36 M6 30 L12 36 L18 30" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      </div>

      <div class="hiw-step" data-step="5">
        <div class="hiw-step-icon">
          <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M24 6L30 18H42L32 26L36 38L24 30L12 38L16 26L6 18H18Z" stroke-linejoin="round"/>
          </svg>
        </div>
        <h3>5. Combined Results</h3>
        <p>If both DTW and k-NN agree on a sign, their confidence scores are
           <strong>averaged</strong> and marked as "DTW+KNN" — giving you higher accuracy
           than either method alone. You see the top 5 matches ranked by confidence.</p>
      </div>
    </div>

    <!-- Community Section -->
    <div class="hiw-community card">
      <h3>Your Contributions Train the AI</h3>
      <p>Every sign you contribute is stored in the library. After each new recording,
         the k-NN classifier <strong>automatically retrains</strong> — meaning the system
         gets smarter with every contribution from the school community.</p>
      <div class="hiw-contribute-flow">
        <div class="hiw-cf-step">
          <span class="hiw-cf-icon">Record</span>
          <span>You perform a sign</span>
        </div>
        <div class="hiw-cf-arrow">&rarr;</div>
        <div class="hiw-cf-step">
          <span class="hiw-cf-icon">Extract</span>
          <span>59-D features computed</span>
        </div>
        <div class="hiw-cf-arrow">&rarr;</div>
        <div class="hiw-cf-step">
          <span class="hiw-cf-icon">Store</span>
          <span>Added to the library</span>
        </div>
        <div class="hiw-cf-arrow">&rarr;</div>
        <div class="hiw-cf-step">
          <span class="hiw-cf-icon">Retrain</span>
          <span>Model accuracy improves</span>
        </div>
      </div>
    </div>

    <div class="hiw-privacy info-card">
      <h4>Privacy First</h4>
      <p>SgSL Hub never stores video or images. Only hand landmark coordinates
         (21 points per frame) are recorded and sent to the server. Your camera
         feed stays in your browser — the AI sees numbers, not pictures.</p>
    </div>
  `;

  // Animate steps on scroll
  const steps = section.querySelectorAll('.hiw-step');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) e.target.classList.add('hiw-visible');
    });
  }, { threshold: 0.15 });
  steps.forEach(s => observer.observe(s));
}
