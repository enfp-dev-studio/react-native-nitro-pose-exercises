/** Normalized engine coordinates. The preview transform owns rotation/mirroring. */
export type ReferencePosePoint = { x: number; y: number };
export type ReferencePoseRawPoint = ReferencePosePoint & { visibility: number };
export type ReferencePoseDisplayPoint = ReferencePosePoint & { index: number };
export type ReferencePoseCacheEntry = { point: ReferencePosePoint; timeMs: number };

export type ReferencePoseObservation = {
  resultId: number;
  timeMs: number;
  /** ML Kit indices; unused/missing entries are null. Index 33 is display-only neck. */
  rawPoints: (ReferencePoseRawPoint | null)[];
  /** Per-result memo, separate from the persistent cache and displayed raw points. */
  cachePoints: (ReferencePosePoint | null)[];
  strong: ReferencePoseDisplayPoint[];
  weak: ReferencePoseDisplayPoint[];
};

export type ReferencePoseTrackerState = {
  cacheEntries: (ReferencePoseCacheEntry | null)[];
  jumpCounts: number[];
  previousDisplay: {
    strong: ReferencePoseDisplayPoint[];
    weak: ReferencePoseDisplayPoint[];
  } | null;
  lastObservation: ReferencePoseObservation | null;
};

export type ReferencePoseTrackerInput = {
  resultId: number;
  /** Monotonic milliseconds from the same clock throughout a tracker session. */
  timeMs: number;
  landmarks: readonly (ReferencePoseRawPoint | null | undefined)[];
  /** Previous counter baseline; update it only after choosing this frame's display. */
  shoulderWidthBaseline: number;
};

export type ReferencePoseTrackerResult = {
  state: ReferencePoseTrackerState;
  observation: ReferencePoseObservation;
};

export function createReferencePoseTrackerState(): ReferencePoseTrackerState {
  'worklet';
  return {
    cacheEntries: new Array<ReferencePoseCacheEntry | null>(34).fill(null),
    jumpCounts: new Array<number>(34).fill(0),
    previousDisplay: null,
    lastObservation: null,
  };
}

/**
 * Advances the cache once per result, in joint dependency order, for both the
 * counter and renderer. Input/output retain top-left normalized coordinates.
 * Coordinates are clamped without an additional visibility or bounds gate.
 * Interpolation uses JavaScript number precision.
 * Helpers are local so this worklet has no imported runtime-function dependency.
 */
export function advanceReferencePoseTracker(
  state: ReferencePoseTrackerState,
  input: ReferencePoseTrackerInput,
): ReferencePoseTrackerResult {
  'worklet';
  const last = state.lastObservation;
  if (last && (input.resultId <= last.resultId || input.timeMs < last.timeMs)) {
    // Transport guard: repeated packets cannot
    // increment the jump counter or refresh cached timestamps a second time.
    return { state, observation: last };
  }

  const indices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const rawPoints = new Array<ReferencePoseRawPoint | null>(34).fill(null);
  for (const index of indices) {
    const point = input.landmarks[index];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)
      && Number.isFinite(point.visibility)) {
      rawPoints[index] = {
        x: Math.max(0, Math.min(1, point.x)),
        y: Math.max(0, Math.min(1, point.y)),
        visibility: point.visibility,
      };
    }
  }

  const cacheEntries = state.cacheEntries.slice();
  const jumpCounts = state.jumpCounts.slice();
  const cachePoints = new Array<ReferencePosePoint | null>(34).fill(null);
  const requested = new Array<boolean>(34).fill(false);
  const timeMs = input.timeMs;

  // Memoize null as well, so repeated reads never re-run state changes.
  const read = (index: number): ReferencePosePoint | null => {
    if (requested[index]) return cachePoints[index] as ReferencePosePoint | null;
    requested[index] = true;
    const raw = rawPoints[index];
    const previous = cacheEntries[index];
    let point: ReferencePosePoint | null = null;
    if (raw && raw.visibility >= 0.18) {
      if (previous && timeMs - previous.timeMs < 120
        && Math.hypot(raw.x - previous.point.x, raw.y - previous.point.y) > 0.2
        && jumpCounts[index]! < 2) {
        jumpCounts[index]! += 1;
        point = previous.point;
        // Holding a jump DOES refresh time; a missing/low-confidence point does not.
        cacheEntries[index] = { point, timeMs };
        cachePoints[index] = point;
        return point;
      }
      jumpCounts[index] = 0;
      if (previous && timeMs - previous.timeMs < 300) {
        const alpha = raw.visibility < 0.3 ? 0.3 : Math.min(0.9, Math.max(0.6, raw.visibility));
        point = {
          x: previous.point.x + alpha * (raw.x - previous.point.x),
          y: previous.point.y + alpha * (raw.y - previous.point.y),
        };
      } else {
        point = { x: raw.x, y: raw.y };
      }
      cacheEntries[index] = { point, timeMs };
    } else if (previous && timeMs - previous.timeMs < 400) {
      point = previous.point;
      // Leave both the persistent timestamp and jump counter unchanged here.
    }
    cachePoints[index] = point;
    return point;
  };

  // Arm angles short-circuit at a missing shoulder or elbow.
  const leftShoulder = read(11);
  if (leftShoulder && read(13)) read(15);
  const rightShoulder = read(12);
  if (rightShoulder && read(14)) read(16);

  // The hip feature check can request an elbow even when the
  // arm-angle path skipped it. The right check is short-circuited by the left.
  const leftHip = read(23);
  const rightHip = read(24);
  const hip = leftHip && rightHip
    ? { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 }
    : leftHip ?? rightHip; // Use the available side when only one exists.
  if (hip) {
    const width = leftShoulder && rightShoulder
      ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
      : 0.15;
    const leftElbow = read(13);
    if (!leftElbow || Math.hypot(hip.x - leftElbow.x, hip.y - leftElbow.y) >= width * 0.25) {
      read(14);
    }
  }

  // Wrist midpoint reads both wrists regardless of arm completeness.
  read(15);
  read(16);
  // Leg geometry requires a hip, knee, and ankle in that order.
  if (read(23) && read(25)) read(27);
  if (read(24) && read(26)) read(28);
  read(0); // Cache the nose even though the renderer skips its dot.

  let strong: ReferencePoseDisplayPoint[] = [];
  let weak: ReferencePoseDisplayPoint[] = [];
  let displayLeft: ReferencePoseDisplayPoint | null = null;
  let displayRight: ReferencePoseDisplayPoint | null = null;
  let leftStrong = false;
  let rightStrong = false;
  for (const index of indices) {
    const raw = rawPoints[index];
    const cached = cacheEntries[index];
    let point: ReferencePoseDisplayPoint | null = null;
    let isStrong = false;
    if (raw && raw.visibility >= 0.5) {
      point = { index, x: raw.x, y: raw.y };
      isStrong = true;
    } else if (cached && timeMs - cached.timeMs < 150) {
      point = { index, ...cached.point };
      isStrong = true;
    } else if (cached && timeMs - cached.timeMs < 400) {
      point = { index, ...cached.point };
    }
    if (!point) continue;
    if (isStrong) strong.push(point);
    else weak.push(point);
    if (index === 11) { displayLeft = point; leftStrong = isStrong; }
    if (index === 12) { displayRight = point; rightStrong = isStrong; }
  }

  let preservedPrevious = false;
  let previousDisplay = state.previousDisplay;
  if (displayLeft && displayRight) {
    const neck = { index: 33, x: (displayLeft.x + displayRight.x) / 2, y: (displayLeft.y + displayRight.y) / 2 };
    if (leftStrong && rightStrong) strong.push(neck);
    else weak.push(neck);
    // Compare against the previous baseline and preserve both complete maps.
    // This display-preservation path has no separate age limit.
    if (input.shoulderWidthBaseline > 0 && previousDisplay
      && Math.hypot(displayLeft.x - displayRight.x, displayLeft.y - displayRight.y)
        < 0.5 * input.shoulderWidthBaseline) {
      strong = previousDisplay.strong;
      weak = previousDisplay.weak;
      preservedPrevious = true;
    }
  }
  if (!preservedPrevious) previousDisplay = { strong, weak };

  const observation: ReferencePoseObservation = {
    resultId: input.resultId, timeMs, rawPoints, cachePoints,
    strong, weak,
  };
  return {
    state: { cacheEntries, jumpCounts, previousDisplay, lastObservation: observation },
    observation,
  };
}
