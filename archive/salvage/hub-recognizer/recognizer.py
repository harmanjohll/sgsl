"""
SgSL Hub — Sign Language Recognition Engine.

Two-stage recognizer:
1. DTW (Dynamic Time Warping) — works from the very first sample
2. k-NN classifier on resampled feature vectors — improves with more data

Supports both legacy single-hand format and new holistic format:
  Legacy: [[x,y,z], ...21 landmarks...]  (per frame)
  Holistic: { leftHand: [...], rightHand: [...], face: [...], pose: [...] }

Feature vector per frame:
  - Per hand (59-D each): 16 bone direction unit vectors (48-D) + fingertip distances (11-D)
  - Face (12-D): key distance ratios for brow raise, mouth shape, eye wideness
  - Total: up to 130-D when both hands + face present
  - Gracefully degrades: single hand = 59-D, no face = skip face features
"""

import numpy as np
from sklearn.neighbors import KNeighborsClassifier

# MediaPipe hand skeleton
BONES = [
    (1, 2), (2, 3), (3, 4),        # thumb
    (5, 6), (6, 7), (7, 8),        # index
    (9, 10), (10, 11), (11, 12),   # middle
    (13, 14), (14, 15), (15, 16),  # ring
    (17, 18), (18, 19), (19, 20),  # pinky
    (0, 5),                        # palm
]

FINGERTIPS = [4, 8, 12, 16, 20]
RESAMPLE_LEN = 32

# Key face landmark indices (must match camera.js FACE_KEY_INDICES)
# 10 brow + 8 eye + 3 nose + 8 mouth + 3 jaw = 32 points
# Index positions within the subset array:
_FACE_LEFT_BROW = list(range(0, 5))
_FACE_RIGHT_BROW = list(range(5, 10))
_FACE_LEFT_EYE = list(range(10, 14))   # corners + top/bottom
_FACE_RIGHT_EYE = list(range(14, 18))
_FACE_NOSE = list(range(18, 21))
_FACE_MOUTH = list(range(21, 29))      # outer ring
_FACE_JAW = list(range(29, 32))


# ---- Frame normalization ----

def normalize_hand(landmarks):
    """Normalize a single 21-landmark hand: wrist-relative, scale-invariant."""
    if landmarks is None:
        return None
    pts = np.array(landmarks, dtype=np.float64)
    if pts.shape[0] < 21:
        return None
    if pts.ndim == 1:
        return None
    if pts.shape[1] == 2:
        pts = np.column_stack([pts, np.zeros(pts.shape[0])])
    wrist = pts[0]
    pts = pts - wrist
    palm_len = np.linalg.norm(pts[9] - pts[0])
    if palm_len < 1e-8:
        return None
    pts = pts / palm_len
    return pts


def extract_hand_features(pts):
    """Extract 59-D feature vector from normalized 21 hand landmarks."""
    feats = []
    for a, b in BONES:
        d = pts[b] - pts[a]
        n = np.linalg.norm(d)
        if n > 1e-8:
            d = d / n
        feats.extend(d.tolist())

    for i in range(len(FINGERTIPS)):
        for j in range(i + 1, len(FINGERTIPS)):
            feats.append(float(np.linalg.norm(pts[FINGERTIPS[i]] - pts[FINGERTIPS[j]])))
    feats.append(float(np.linalg.norm(pts[4] - pts[0])))
    return feats


def extract_face_features(face_pts):
    """Extract 12-D face feature vector from the key face landmark subset.

    Features encode relative proportions (scale-invariant):
      - Left/right brow raise (2): avg vertical position of brow relative to eye
      - Left/right eye openness (2): top-bottom distance / horizontal width
      - Mouth width (1): horizontal extent / face width
      - Mouth height (1): vertical extent / face width
      - Mouth aspect ratio (1): width / height
      - Lip separation (1): inner mouth opening
      - Jaw drop (1): chin distance from nose
      - Head tilt (1): angle of eye line
      - Head turn (1): nose offset from midline
      - Brow furrow (1): distance between inner brow points
    """
    if face_pts is None:
        return None
    pts = np.array(face_pts, dtype=np.float64)
    if pts.shape[0] < 32:
        return None
    if pts.shape[1] == 2:
        pts = np.column_stack([pts, np.zeros(pts.shape[0])])

    # Normalize: center on nose tip, scale by inter-eye distance
    nose = pts[_FACE_NOSE[0]]  # nose tip
    left_eye_outer = pts[_FACE_LEFT_EYE[0]]
    right_eye_outer = pts[_FACE_RIGHT_EYE[0]]
    face_width = np.linalg.norm(left_eye_outer - right_eye_outer)
    if face_width < 1e-8:
        return None
    pts = (pts - nose) / face_width

    feats = []

    # Brow raise: avg y of brow points relative to eye top
    left_brow_y = np.mean([pts[i][1] for i in _FACE_LEFT_BROW])
    left_eye_top = pts[_FACE_LEFT_EYE[2]][1]  # top of left eye
    feats.append(float(left_brow_y - left_eye_top))

    right_brow_y = np.mean([pts[i][1] for i in _FACE_RIGHT_BROW])
    right_eye_top = pts[_FACE_RIGHT_EYE[2]][1]
    feats.append(float(right_brow_y - right_eye_top))

    # Eye openness: vertical / horizontal ratio
    for eye_idx in [_FACE_LEFT_EYE, _FACE_RIGHT_EYE]:
        horiz = np.linalg.norm(pts[eye_idx[0]] - pts[eye_idx[1]])
        vert = np.linalg.norm(pts[eye_idx[2]] - pts[eye_idx[3]])
        feats.append(float(vert / (horiz + 1e-8)))

    # Mouth dimensions
    mouth_pts = [pts[i] for i in _FACE_MOUTH]
    mouth_xs = [p[0] for p in mouth_pts]
    mouth_ys = [p[1] for p in mouth_pts]
    mouth_w = max(mouth_xs) - min(mouth_xs)
    mouth_h = max(mouth_ys) - min(mouth_ys)
    feats.append(float(mouth_w))      # mouth width
    feats.append(float(mouth_h))      # mouth height
    feats.append(float(mouth_w / (mouth_h + 1e-8)))  # aspect ratio

    # Lip separation (top lip to bottom lip)
    top_lip = pts[_FACE_MOUTH[4]]    # index 13 in MediaPipe = top inner lip
    bottom_lip = pts[_FACE_MOUTH[5]] # index 14 = bottom inner lip
    feats.append(float(np.linalg.norm(top_lip - bottom_lip)))

    # Jaw drop
    chin = pts[_FACE_JAW[0]]
    feats.append(float(chin[1]))  # already nose-relative

    # Head tilt (angle of line between outer eye corners)
    eye_vec = right_eye_outer - left_eye_outer
    feats.append(float(np.arctan2(eye_vec[1], eye_vec[0])))

    # Head turn (nose x offset from eye midline — already normalized)
    feats.append(float(pts[_FACE_NOSE[0]][0]))

    # Brow furrow (inner brow distance)
    inner_left = pts[_FACE_LEFT_BROW[4]]   # innermost left brow point
    inner_right = pts[_FACE_RIGHT_BROW[0]]  # innermost right brow point
    feats.append(float(np.linalg.norm(inner_left - inner_right)))

    return feats  # 12-D


# ---- Legacy support ----

def _is_legacy_frame(frame):
    """Check if a frame is legacy format (flat array of 21 landmarks)."""
    if isinstance(frame, list) and len(frame) >= 21:
        if isinstance(frame[0], (list, tuple)) and len(frame[0]) >= 2:
            return True
    return False


def _is_holistic_frame(frame):
    """Check if a frame is new holistic format (dict with leftHand/rightHand)."""
    return isinstance(frame, dict) and ('leftHand' in frame or 'rightHand' in frame)


SPATIAL_DIM = 9  # spatial relationship features


def extract_spatial_features(frame):
    """Extract 9-D spatial relationship features.

    Encodes WHERE hands are relative to the face (and each other):
      1-3: Right wrist position relative to nose (x, y, z) — face-scale normalized
      4-6: Left wrist position relative to nose (x, y, z)
      7-9: Hand-to-hand vector (right wrist to left wrist, x, y, z)

    All values are normalized by inter-eye distance for scale invariance.
    This captures the difference between e.g. "thanks" (chin→down) and
    "hello" (same hand shape, different location).
    """
    face_raw = frame.get('face')
    right_raw = frame.get('rightHand')
    left_raw = frame.get('leftHand')

    # We need at least a face reference and one hand
    if not face_raw or len(face_raw) < 32:
        return [0.0] * SPATIAL_DIM

    face_pts = np.array(face_raw, dtype=np.float64)
    # Nose tip (index 18 in our subset) as origin
    nose = face_pts[_FACE_NOSE[0]]
    # Inter-eye distance as scale (indices 10, 14 = outer eye corners)
    left_eye = face_pts[_FACE_LEFT_EYE[0]]
    right_eye = face_pts[_FACE_RIGHT_EYE[0]]
    eye_dist = np.linalg.norm(left_eye - right_eye)
    if eye_dist < 1e-8:
        return [0.0] * SPATIAL_DIM

    feats = []

    # Right wrist relative to nose
    if right_raw and len(right_raw) >= 21:
        rw = np.array(right_raw[0], dtype=np.float64)  # wrist = landmark 0
        rel = (rw - nose) / eye_dist
        feats.extend(rel[:3].tolist())
    else:
        feats.extend([0.0, 0.0, 0.0])

    # Left wrist relative to nose
    if left_raw and len(left_raw) >= 21:
        lw = np.array(left_raw[0], dtype=np.float64)
        rel = (lw - nose) / eye_dist
        feats.extend(rel[:3].tolist())
    else:
        feats.extend([0.0, 0.0, 0.0])

    # Hand-to-hand vector
    if right_raw and len(right_raw) >= 21 and left_raw and len(left_raw) >= 21:
        rw = np.array(right_raw[0], dtype=np.float64)
        lw = np.array(left_raw[0], dtype=np.float64)
        hh = (lw - rw) / eye_dist
        feats.extend(hh[:3].tolist())
    else:
        feats.extend([0.0, 0.0, 0.0])

    return feats  # 9-D


def _extract_frame_combined(frame):
    """Extract features from a single frame (legacy or holistic).

    Returns a feature vector of consistent dimensionality for the sequence,
    or None if no valid hand data.

    Feature layout (139-D for holistic):
      [0-58]   Right hand shape (59-D, wrist-normalized)
      [59-117] Left hand shape (59-D, wrist-normalized)
      [118-129] Face expression (12-D)
      [130-138] Spatial relationships (9-D) — hand-to-face, hand-to-hand
    """
    if _is_legacy_frame(frame):
        # Legacy single-hand: return 59-D (padded to match holistic format)
        pts = normalize_hand(frame)
        if pts is None:
            return None
        hand_feats = extract_hand_features(pts)
        # Pad: 59 (right hand) + 59 zeros (no left) + 12 zeros (face) + 9 zeros (spatial)
        return hand_feats + [0.0] * 59 + [0.0] * 12 + [0.0] * SPATIAL_DIM

    if _is_holistic_frame(frame):
        feats = []

        # Right hand features (dominant hand)
        right = normalize_hand(frame.get('rightHand'))
        if right is not None:
            feats.extend(extract_hand_features(right))
        else:
            feats.extend([0.0] * 59)

        # Left hand features
        left = normalize_hand(frame.get('leftHand'))
        if left is not None:
            feats.extend(extract_hand_features(left))
        else:
            feats.extend([0.0] * 59)

        # Face features
        face_feats = extract_face_features(frame.get('face'))
        if face_feats is not None:
            feats.extend(face_feats)
        else:
            feats.extend([0.0] * 12)

        # Spatial relationship features (hand-to-face, hand-to-hand)
        feats.extend(extract_spatial_features(frame))

        # At least one hand must be present
        if right is None and left is None:
            return None

        return feats  # 139-D

    return None


# ---- Sequence processing ----

def extract_sequence_features(landmarks_seq):
    """Extract per-frame features from a full recording sequence.

    Handles both legacy (list of 21-landmark arrays) and holistic
    (list of {leftHand, rightHand, face, pose} dicts) formats.

    Returns list of feature vectors (one per valid frame).
    """
    if not landmarks_seq:
        return []

    features = []
    for frame in landmarks_seq:
        fv = _extract_frame_combined(frame)
        if fv is not None:
            features.append(fv)
    return features


# ---- Legacy compatibility aliases ----
normalize_frame = normalize_hand
extract_frame_features = extract_hand_features


def resample_sequence(seq, target_len=RESAMPLE_LEN):
    """Resample a variable-length sequence to a fixed number of frames."""
    if not seq:
        return []
    arr = np.array(seq)
    n = len(arr)
    if n == target_len:
        return arr.tolist()
    indices = np.linspace(0, n - 1, target_len)
    resampled = []
    for idx in indices:
        lo = int(np.floor(idx))
        hi = min(lo + 1, n - 1)
        t = idx - lo
        resampled.append(((1 - t) * arr[lo] + t * arr[hi]).tolist())
    return resampled


def flatten_resampled(resampled):
    """Flatten resampled sequence into a single feature vector for k-NN."""
    return [v for frame in resampled for v in frame]


# --- DTW ---
def dtw_distance(seq_a, seq_b):
    """Compute DTW distance between two feature sequences.

    Uses Sakoe-Chiba band constraint for O(n*w) instead of O(n*m).
    Handles sequences with different feature dimensions by truncating
    to the shorter dimension (backward compat: 59-D vs 130-D).
    """
    n, m = len(seq_a), len(seq_b)
    if n == 0 or m == 0:
        return float("inf")
    a = np.array(seq_a)
    b = np.array(seq_b)

    # Handle dimension mismatch between old and new recordings
    dim_a, dim_b = a.shape[1] if a.ndim > 1 else 0, b.shape[1] if b.ndim > 1 else 0
    if dim_a != dim_b and dim_a > 0 and dim_b > 0:
        min_dim = min(dim_a, dim_b)
        a = a[:, :min_dim]
        b = b[:, :min_dim]

    # Sakoe-Chiba band: only compute within a window around the diagonal
    w = max(abs(n - m), max(n, m) // 4, 5)

    cost = np.full((n + 1, m + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        j_start = max(1, i - w)
        j_end = min(m, i + w)
        for j in range(j_start, j_end + 1):
            d = float(np.linalg.norm(a[i - 1] - b[j - 1]))
            cost[i, j] = d + min(cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1])
    path_len = n + m
    return cost[n, m] / path_len


def recognize_dtw(query_features, library):
    """Match query against library using DTW. Returns sorted matches."""
    if not query_features:
        return []
    results = []
    for entry in library:
        ref_features = entry["features"]
        if not ref_features:
            continue
        dist = dtw_distance(query_features, ref_features)
        results.append({"label": entry["label"], "distance": dist, "id": entry["id"]})
    results.sort(key=lambda x: x["distance"])

    if not results:
        return []
    max_dist = max(r["distance"] for r in results) or 1.0
    for r in results:
        r["confidence"] = max(0, 1 - r["distance"] / max_dist)

    seen = {}
    unique = []
    for r in results:
        if r["label"] not in seen:
            seen[r["label"]] = True
            unique.append(r)
    return unique[:5]


# --- k-NN classifier ---
class SignClassifier:
    """k-NN classifier on flattened, resampled feature sequences."""

    def __init__(self):
        self.model = None
        self.labels = []
        self.is_trained = False
        self._feat_dim = None

    def train(self, library):
        """Train from library entries that have features."""
        X, y = [], []
        for entry in library:
            feats = entry.get("features")
            if not feats or len(feats) < 4:
                continue
            resampled = resample_sequence(feats, RESAMPLE_LEN)
            flat = flatten_resampled(resampled)
            X.append(flat)
            y.append(entry["label"])

        if len(X) < 2:
            self.is_trained = False
            return

        unique_labels = set(y)
        if len(unique_labels) < 2:
            self.is_trained = False
            return

        # Normalize dimensions: pad shorter vectors to max length
        max_len = max(len(x) for x in X)
        X = [x + [0.0] * (max_len - len(x)) for x in X]
        self._feat_dim = max_len

        k = min(3, len(X))
        self.model = KNeighborsClassifier(n_neighbors=k, weights="distance", metric="euclidean")
        self.model.fit(X, y)
        self.labels = list(unique_labels)
        self.is_trained = True

    def predict(self, query_features):
        """Predict sign label from feature sequence."""
        if not self.is_trained or not query_features:
            return []
        resampled = resample_sequence(query_features, RESAMPLE_LEN)
        flat = flatten_resampled(resampled)

        # Pad or truncate to match training dimension
        if self._feat_dim is not None:
            if len(flat) < self._feat_dim:
                flat = flat + [0.0] * (self._feat_dim - len(flat))
            elif len(flat) > self._feat_dim:
                flat = flat[:self._feat_dim]

        X = np.array([flat])
        probs = self.model.predict_proba(X)[0]
        classes = self.model.classes_
        results = [
            {"label": str(classes[i]), "confidence": float(probs[i])}
            for i in range(len(classes))
        ]
        results.sort(key=lambda x: x["confidence"], reverse=True)
        return results[:5]


classifier = SignClassifier()
