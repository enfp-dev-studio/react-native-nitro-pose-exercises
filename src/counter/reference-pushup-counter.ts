/**
 * Push-up counting and movement validation for full and knee variants.
 * Input points come from the separate pose tracker, in top-left normalized axes.
 * Display filtering MUST NOT be applied to this input. All time is caller supplied.
 */
export type ReferencePushupMode = 'full' | 'knee';
export type ReferencePushupPhase = 'waitingForUp' | 'up' | 'descent' | 'down' | 'ascent';
export type ReferencePushupPoint = { x: number; y: number };
export type ReferencePushupRawPoint = ReferencePushupPoint & { visibility: number };
export interface ReferencePushupObservation {
  resultId: number;
  timeMs: number;
  cachePoints: readonly (ReferencePushupPoint | null)[];
  rawPoints: readonly (ReferencePushupRawPoint | null)[];
}
export interface ReferencePushupInput {
  observation: ReferencePushupObservation;
  mode: ReferencePushupMode;
  /** Motion peak minus baseline, already processed by the native sensor accumulator. */
  deviceMotion?: number;
}
export interface ReferencePushupFeatures {
  armsVisible: boolean;
  shoulder: ReferencePushupPoint | null;
  wrist: ReferencePushupPoint | null;
  hip: ReferencePushupPoint | null;
  elbowAngle: number;
  torsoLen: number;
  shoulderW: number | null;
  kneeAngle: number | null;
  lowerVisible: boolean;
  hipDetected: boolean;
  hipFresh: boolean;
  legJointFresh: boolean;
  armFresh: boolean;
}
export interface ReferencePushupCandidate {
  startedAt: number | null; // Seconds, from the caller's monotonic clock.
  confirmedMin: number;
  pendingMin: number;
  pendingMinAt: number | null;
  belowAt: number | null;
  highFrames: number;
  partialHighFrames: number;
  gapEvidence: boolean;
  armMissingAt: number | null;
  slowBottom: boolean;
  geometryCompletion: boolean;
  ascentPeak: number;
  shoulderTop: number | null;
  shoulders: number[];
  wrists: number[];
  pairedShoulders: number[];
  pairedHips: number[];
  torsos: number[];
  widths: number[];
  shoulderWristDistances: number[];
  bodyRatios: number[]; // Excludes narrow-shoulder frames.
  allBodyRatios: number[];
  knees: number[];
  lowerFrames: number;
  legFreshFrames: number;
  armFreshFrames: number;
  hipFrames: number; // Cached hip existence before elbow-confusion removal.
  frames: number;
}
export interface ReferencePushupState {
  mode: ReferencePushupMode;
  reps: number;
  lastResultId: number;
  lastInputTimeMs: number;
  lastFeatureAt: number | null;
  phase: ReferencePushupPhase;
  readyAt: number | null;
  waitingPeak: number;
  topShoulder: number | null;
  angleHistory: number[]; // Last three angles.
  filteredAngle: number;
  previousAngle: number | null;
  previousAngleAt: number | null;
  angularVelocity: number;
  widthHistory: number[]; // Last 24 widths.
  shoulderHistory: number[]; // Last 150 shoulder positions.
  medianShoulderWidth: number;
  shoulderWidthBaseline: number; // 75th percentile; feed the next tracker update.
  lastAcceptedAt: number | null;
  hasAccepted: boolean;
  candidate: ReferencePushupCandidate;
  lastReasons: string[];
}
export interface ReferencePushupResult {
  state: ReferencePushupState;
  reps: number;
  accepted: boolean;
  phase: ReferencePushupPhase;
  /** Normalized movement depth, separate from landmark probability. */
  progress: number;
  reasons: string[];
  event: 'none' | 'accepted' | 'rejected' | 'reset' | 'ignored';
  features: ReferencePushupFeatures | null;
}

function ordered(values: readonly number[]): number[] {
  'worklet';
  const result = values.slice();
  // Avoid comparator callbacks that some worklet compilers hoist to RN.
  for (let i = 1; i < result.length; i++) {
    const value = result[i]!; let j = i - 1;
    while (j >= 0 && result[j]! > value) { result[j + 1] = result[j]!; j--; }
    result[j + 1] = value;
  }
  return result;
}
function median(values: readonly number[]): number {
  'worklet';
  return values.length ? ordered(values)[Math.floor(values.length / 2)]! : 0;
}
export function referencePushupRobustSpan(values: readonly number[]): number {
  'worklet';
  if (!values.length) return 0;
  const sorted = ordered(values);
  return values.length < 5 ? sorted[sorted.length - 1]! - sorted[0]!
    : sorted[Math.round((sorted.length - 1) * 0.9)]! - sorted[Math.round((sorted.length - 1) * 0.1)]!;
}
function distance(a: ReferencePushupPoint, b: ReferencePushupPoint): number {
  'worklet';
  return Math.hypot(Math.fround(a.x - b.x), Math.fround(a.y - b.y));
}
function referencePushupAngle(a: ReferencePushupPoint, b: ReferencePushupPoint, c: ReferencePushupPoint): number {
  'worklet';
  // Preserve single-precision subtraction/multiplication before angle division.
  const ax = Math.fround(a.x - b.x), ay = Math.fround(a.y - b.y);
  const cx = Math.fround(c.x - b.x), cy = Math.fround(c.y - b.y);
  const dot = Math.fround(Math.fround(ax * cx) + Math.fround(ay * cy));
  const denominator = Math.hypot(ax, ay) * Math.hypot(cx, cy);
  return denominator <= 0 ? 180 : Math.acos(Math.max(-1, Math.min(1, dot / denominator))) * 180 / Math.PI;
}
function midpoint(a: ReferencePushupPoint | null, b: ReferencePushupPoint | null): ReferencePushupPoint | null {
  'worklet';
  if (!a) return b;
  if (!b) return a;
  return { x: Math.fround(Math.fround(a.x + b.x) / 2), y: Math.fround(Math.fround(a.y + b.y) / 2) };
}
function referencePoint(point: ReferencePushupPoint | null | undefined): ReferencePushupPoint | null {
  'worklet';
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: Math.fround(Math.max(0, Math.min(1, 1 - point.x))), y: Math.fround(Math.max(0, Math.min(1, 1 - point.y))) };
}
function rawVisible(observation: ReferencePushupObservation, index: number): boolean {
  'worklet';
  const point = observation.rawPoints[index];
  return !!point && Number.isFinite(point.visibility) && point.visibility >= 0.18;
}
export function extractReferencePushupFeatures(observation: ReferencePushupObservation): ReferencePushupFeatures {
  'worklet';
  const points: (ReferencePushupPoint | null)[] = [];
  for (let i = 0; i < 34; i++) points.push(referencePoint(observation.cachePoints[i]));
  const ls = points[11], rs = points[12], le = points[13], re = points[14], lw = points[15], rw = points[16];
  const leftAngle = ls && le && lw ? referencePushupAngle(ls, le, lw) : null;
  const rightAngle = rs && re && rw ? referencePushupAngle(rs, re, rw) : null;
  const shoulder = midpoint(ls as ReferencePushupPoint | null, rs as ReferencePushupPoint | null), wrist = midpoint(lw as ReferencePushupPoint | null, rw as ReferencePushupPoint | null);
  const shoulderW = ls && rs ? distance(ls, rs) : null;
  let hip = midpoint(points[23] as ReferencePushupPoint | null, points[24] as ReferencePushupPoint | null);
  const hipDetected = hip !== null;
  // Reject cached hips confused with either elbow before torso extraction.
  if (hip && ((le && distance(hip, le) < 0.25 * (shoulderW ?? 0.15))
    || (re && distance(hip, re) < 0.25 * (shoulderW ?? 0.15)))) hip = null;
  let lowerVisible = false, kneeAngle: number | null = null;
  for (let side = 0; side < 2; side++) {
    const h = points[23 + side], k = points[25 + side], a = points[27 + side];
    if (!h || !k || !a) continue;
    lowerVisible = true;
    // An excluded knee still contributes lowerVisible=true.
    if (shoulder && referencePushupAngle(shoulder, h, k) < 45) continue;
    const proximity = Math.max(shoulderW ?? 0.15, 0.01) * 0.35;
    if ((lw && distance(k, lw) < proximity) || (rw && distance(k, rw) < proximity)) continue;
    if (!rawVisible(observation, 23 + side) || !rawVisible(observation, 25 + side)
      || !rawVisible(observation, 27 + side)) continue;
    const angle = referencePushupAngle(h, k, a);
    kneeAngle = kneeAngle === null ? angle : Math.max(kneeAngle, angle);
  }
  return {
    armsVisible: leftAngle !== null || rightAngle !== null,
    shoulder, wrist, hip,
    elbowAngle: leftAngle === null ? rightAngle ?? 180 : rightAngle === null ? leftAngle : Math.min(leftAngle, rightAngle),
    torsoLen: shoulder && hip ? distance(shoulder, hip) : 0, shoulderW, kneeAngle, lowerVisible, hipDetected,
    hipFresh: rawVisible(observation, 23) || rawVisible(observation, 24),
    legJointFresh: rawVisible(observation, 25) || rawVisible(observation, 26) || rawVisible(observation, 27) || rawVisible(observation, 28),
    armFresh: (rawVisible(observation, 11) && rawVisible(observation, 13) && rawVisible(observation, 15))
      || (rawVisible(observation, 12) && rawVisible(observation, 14) && rawVisible(observation, 16)),
  };
}

function emptyCandidate(): ReferencePushupCandidate {
  'worklet';
  return { startedAt: null, confirmedMin: 180, pendingMin: 180, pendingMinAt: null, belowAt: null,
    highFrames: 0, partialHighFrames: 0, gapEvidence: false, armMissingAt: null, slowBottom: false,
    geometryCompletion: false, ascentPeak: 0, shoulderTop: null,
    shoulders: [], wrists: [], pairedShoulders: [], pairedHips: [],
    torsos: [], widths: [], shoulderWristDistances: [], bodyRatios: [], allBodyRatios: [], knees: [],
    lowerFrames: 0, legFreshFrames: 0, armFreshFrames: 0, hipFrames: 0, frames: 0 };
}
export function createReferencePushupState(mode: ReferencePushupMode = 'full', initialReps = 0): ReferencePushupState {
  'worklet';
  return { mode, reps: Math.max(0, Math.trunc(initialReps)), lastResultId: -1, lastInputTimeMs: -1,
    lastFeatureAt: null, phase: 'waitingForUp', readyAt: null, waitingPeak: 0, topShoulder: null,
    angleHistory: [], filteredAngle: 180, previousAngle: null, previousAngleAt: null, angularVelocity: 0,
    widthHistory: [], shoulderHistory: [], medianShoulderWidth: 0, shoulderWidthBaseline: 0,
    lastAcceptedAt: null, hasAccepted: false, candidate: emptyCandidate(), lastReasons: [] };
}
function copyState(state: ReferencePushupState): ReferencePushupState {
  'worklet';
  const c = state.candidate;
  return { ...state, angleHistory: state.angleHistory.slice(), widthHistory: state.widthHistory.slice(),
    shoulderHistory: state.shoulderHistory.slice(), lastReasons: state.lastReasons.slice(),
    candidate: { ...c,
      shoulders: c.shoulders.slice(), wrists: c.wrists.slice(),
      pairedShoulders: c.pairedShoulders.slice(), pairedHips: c.pairedHips.slice(),
      torsos: c.torsos.slice(), widths: c.widths.slice(), shoulderWristDistances: c.shoulderWristDistances.slice(),
      bodyRatios: c.bodyRatios.slice(), allBodyRatios: c.allBodyRatios.slice(), knees: c.knees.slice() } };
}
function resetCandidate(state: ReferencePushupState): void {
  'worklet';
  state.candidate = emptyCandidate(); state.readyAt = null; state.waitingPeak = 0; state.topShoulder = null;
}
function collect(state: ReferencePushupState, feature: ReferencePushupFeatures): void {
  'worklet';
  const c = state.candidate; c.frames++;
  if (!feature.shoulder) return;
  const y = feature.shoulder.y, width = feature.shoulderW;
  c.shoulders.push(y);
  const narrow = state.shoulderWidthBaseline > 0
    && (width ?? state.shoulderWidthBaseline) < 0.5 * state.shoulderWidthBaseline;
  if (feature.hipDetected) c.hipFrames++;
  if (feature.hip) {
    if (feature.hipFresh) { c.pairedShoulders.push(y); c.pairedHips.push(feature.hip.y); }
    if (width !== null && width > 0) {
      const ratio = (y - feature.hip.y) / width;
      c.allBodyRatios.push(ratio);
      if (!narrow) c.bodyRatios.push(ratio);
    }
  }
  if (!narrow && feature.wrist) c.wrists.push(feature.wrist.y);
  if (feature.torsoLen > 0) c.torsos.push(feature.torsoLen);
  if (!narrow && width !== null && width > 0) c.widths.push(width);
  if (!narrow && feature.wrist) c.shoulderWristDistances.push(distance(feature.shoulder, feature.wrist));
  if (feature.lowerVisible) c.lowerFrames++;
  if (feature.legJointFresh) c.legFreshFrames++;
  if (feature.armFresh) c.armFreshFrames++;
  if (feature.kneeAngle !== null) c.knees.push(feature.kneeAngle);
}
function confirmMinimum(c: ReferencePushupCandidate, angle: number, now: number): void {
  'worklet';
  if (c.pendingMinAt === null || angle > c.pendingMin + 15 || angle < c.pendingMin - 15) {
    c.pendingMin = angle; c.pendingMinAt = now;
  } else c.pendingMin = Math.min(c.pendingMin, angle);
  if (now - c.pendingMinAt >= 0.09) c.confirmedMin = Math.min(c.confirmedMin, c.pendingMin);
}
function shoulderDrop(c: ReferencePushupCandidate): number {
  'worklet';
  if (!c.shoulders.length) return 0;
  const sorted = ordered(c.shoulders);
  return Math.max(referencePushupRobustSpan(c.shoulders),
    (c.shoulderTop ?? sorted[sorted.length - 1]!) - sorted[Math.round((sorted.length - 1) * 0.1)]!);
}
function candidateWidth(c: ReferencePushupCandidate): number {
  'worklet'; return c.widths.length >= 6 ? median(c.widths) : 0;
}
function geometricEvidence(state: ReferencePushupState): boolean {
  'worklet';
  const c = state.candidate, width = candidateWidth(c);
  if (c.shoulderWristDistances.length < 6 || c.widths.length < 6 || width <= 0
    || referencePushupRobustSpan(c.shoulderWristDistances) / width < 0.2) return false;
  const drop = shoulderDrop(c), recentWidth = median(c.widths.slice(0, 5));
  const depth = Math.max(state.medianShoulderWidth > 0 ? drop / state.medianShoulderWidth : 0,
    recentWidth > 0 ? drop / recentWidth : 0);
  return depth >= (state.mode === 'knee' ? 0.2 : 0.15);
}

/** Validate a completed candidate and return stable diagnostic reason codes. */
function judgeCandidate(state: ReferencePushupState, now: number, motion: number): string[] {
  'worklet';
  const c = state.candidate, reasons: string[] = [];
  const drop = shoulderDrop(c), width = candidateWidth(c);
  const baseline = state.medianShoulderWidth > 0 ? state.medianShoulderWidth : width;
  if (state.hasAccepted && state.lastAcceptedAt !== null && now - state.lastAcceptedAt > 5
    && state.shoulderHistory.length >= 20 && baseline > 0 && c.shoulders.length) {
    const history = ordered(state.shoulderHistory), top = c.shoulderTop ?? ordered(c.shoulders)[c.shoulders.length - 1]!;
    if ((top - history[Math.round((history.length - 1) * 0.1)]!) / baseline > 0.9) reasons.push('not-from-plank');
  }
  if (state.lastAcceptedAt !== null && now - state.lastAcceptedAt < 0.55) reasons.push('too-fast');
  if (motion > 0.12) reasons.push('phone-moving');
  // Measure the starting width from the first five samples.
  const firstWidth = c.widths.length >= 3 ? median(c.widths.slice(0, 5)) : 0;
  const depth = Math.max(baseline > 0 ? drop / baseline : 0, firstWidth > 0 ? drop / firstWidth : 0);
  if (baseline <= 0 && firstWidth <= 0) {
    const minimum = c.torsos.length >= 6 ? Math.min(0.04, Math.max(0.022, median(c.torsos) * 0.15)) : 0.04;
    if (drop < minimum) reasons.push('no-movement');
  } else if (depth < (state.mode === 'knee' ? 0.2 : 0.15)) reasons.push('too-shallow');
  let bendGood = false;
  if (width > 0 && c.shoulderWristDistances.length >= 6) {
    bendGood = referencePushupRobustSpan(c.shoulderWristDistances) / width >= 0.1;
    if (!bendGood) reasons.push('no-bend');
  }
  if (!c.slowBottom && !c.gapEvidence && !c.geometryCompletion) {
    reasons.push(c.confirmedMin > 100 && c.armFreshFrames >= 4 ? 'too-shallow-elbow' : 'no-pause-at-bottom');
  }
  const wristSpan = referencePushupRobustSpan(c.wrists);
  const handsGood = c.wrists.length < 6 || wristSpan <= 0.03 || wristSpan <= drop;
  const widthHandsGood = width <= 0 || c.wrists.length < 6 || wristSpan / width <= 0.3;
  if (!handsGood) reasons.push('hands-moved');
  if (!widthHandsGood) reasons.push('hands-moved-width');
  const hipRatio = c.frames > 0 ? c.hipFrames / c.frames : 0;
  const bottomHands = c.confirmedMin <= 100 && handsGood && widthHandsGood;
  const fallback = ((bendGood || c.confirmedMin <= 100) && handsGood && widthHandsGood && hipRatio >= 0.06)
    || (bottomHands && depth >= 0.35 && hipRatio >= 0.03)
    || (bottomHands && depth >= 0.35 && (c.lowerFrames >= 2 || c.legFreshFrames >= 4));
  const pairedDrop = referencePushupRobustSpan(c.pairedShoulders);
  const pairedHipDrop = referencePushupRobustSpan(c.pairedHips);
  if (state.mode === 'full' && c.pairedShoulders.length >= 6 && pairedDrop >= 0.02
    && pairedHipDrop / pairedDrop < 0.02) reasons.push('hips-pinned');
  if (width > 0 && !fallback && c.widths.length >= 6 && referencePushupRobustSpan(c.widths) / width > 0.35) reasons.push('distance-changed');
  if (hipRatio < 0.14 && !fallback) reasons.push('hips-missing');
  if (c.bodyRatios.length >= 6 && median(c.bodyRatios) > (state.mode === 'knee' ? 1.75 : 1.4)) reasons.push('upright');
  const body = c.bodyRatios.length >= 3 ? c.bodyRatios : c.allBodyRatios;
  if ((c.knees.length >= 12 || (c.knees.length >= 6 && c.frames > 0 && c.knees.length / c.frames >= 0.6))
    && body.length >= 3 && median(body) > 0.95) reasons.push('not-pushup-position');
  if (state.mode === 'full' && hipRatio >= 0.85 && depth < 0.5 && body.length >= 3 && median(body) < 0.5) reasons.push('piked');
  if (state.mode === 'full' && c.pairedShoulders.length >= 6 && pairedDrop >= 0.04) {
    const limit = 1.6 + (1 - hipRatio) * 0.5 + (depth >= 0.5 && c.confirmedMin <= 95 ? 0.6 : 0);
    if (hipRatio >= 0.5 && pairedHipDrop / pairedDrop > limit) reasons.push('hips-collapsed');
  }
  if (state.mode === 'full' && c.knees.length >= 20 && ordered(c.knees)[Math.floor(c.knees.length / 10)]! < 30) {
    let bent = 0;
    for (let i = 0; i < c.knees.length; i++) if (c.knees[i]! < 30) bent++;
    if (bent >= 8 && bent / c.knees.length >= 0.34) reasons.push('knees-bent');
  }
  return reasons;
}
function finishCandidate(state: ReferencePushupState, now: number, motion: number): boolean {
  'worklet';
  const reasons = judgeCandidate(state, now, motion);
  state.lastReasons = reasons;
  const accepted = reasons.length === 0;
  if (accepted) {
    state.reps++; state.lastAcceptedAt = now; state.hasAccepted = true;
  }
  state.phase = 'up'; resetCandidate(state);
  return accepted;
}
function startDescent(state: ReferencePushupState, feature: ReferencePushupFeatures, now: number): void {
  'worklet';
  const top = state.topShoulder ?? feature.shoulder!.y;
  resetCandidate(state); state.phase = 'descent';
  state.candidate.startedAt = now; state.candidate.confirmedMin = state.filteredAngle;
  state.candidate.shoulderTop = top; collect(state, feature);
}
function makeResult(state: ReferencePushupState, features: ReferencePushupFeatures | null,
  delta: 0 | 1, event: ReferencePushupResult['event']): ReferencePushupResult {
  'worklet';
  const progress = features?.armsVisible && features.shoulder ? Math.max(0, Math.min(1, (148 - state.filteredAngle) / 48)) : 0;
  return { state, reps: state.reps, accepted: delta === 1, phase: state.phase,
    progress,
    reasons: state.lastReasons.slice(), event, features };
}
/** Consumes one completed ML result. Duplicate/stale IDs cannot advance timers or count twice. */
export function updateReferencePushupCounter(previous: ReferencePushupState, input: ReferencePushupInput): ReferencePushupResult {
  'worklet';
  const observation = input.observation;
  if (!Number.isFinite(observation.resultId) || !Number.isFinite(observation.timeMs)
    || observation.resultId <= previous.lastResultId || observation.timeMs <= previous.lastInputTimeMs) {
    return makeResult(previous, null, 0, 'ignored');
  }
  const state = input.mode === previous.mode ? copyState(previous) : createReferencePushupState(input.mode, previous.reps);
  state.lastResultId = observation.resultId; state.lastInputTimeMs = observation.timeMs;
  const now = observation.timeMs / 1000, features = extractReferencePushupFeatures(observation);
  let event: ReferencePushupResult['event'] = input.mode === previous.mode ? 'none' : 'reset';
  if (state.lastFeatureAt !== null && state.lastFeatureAt > 0 && now - state.lastFeatureAt > 1.5) {
    state.shoulderHistory = []; state.hasAccepted = false; state.phase = 'waitingForUp';
    resetCandidate(state); event = 'reset';
  }
  state.lastFeatureAt = now;
  state.angleHistory.push(features.elbowAngle);
  if (state.angleHistory.length > 3) state.angleHistory.shift();
  const rawAngle = state.angleHistory.length === 3 ? median(state.angleHistory) : features.elbowAngle;
  const alpha = Math.abs(rawAngle - state.filteredAngle) > 1.5 ? 0.85 : 0.3;
  state.filteredAngle += (rawAngle - state.filteredAngle) * alpha;
  const dt = state.previousAngleAt !== null && now > state.previousAngleAt ? now - state.previousAngleAt : 0;
  state.angularVelocity = state.previousAngle !== null && dt > 0
    ? (state.filteredAngle - state.previousAngle) / Math.max(0.01, Math.min(0.2, dt)) : 0;
  state.previousAngle = state.filteredAngle; state.previousAngleAt = now;
  const angle = state.filteredAngle;
  if ((state.phase === 'descent' || state.phase === 'down') && dt > 0.15 && angle <= 134) state.candidate.gapEvidence = true;
  if (!features.shoulder || !features.armsVisible) return makeResult(state, features, 0, event);
  let c = state.candidate;
  if ((state.phase === 'descent' || state.phase === 'down') && !features.armFresh) {
    if (c.armMissingAt === null) c.armMissingAt = now;
    if (now - c.armMissingAt > 0.15 && angle <= 134) c.gapEvidence = true;
  } else c.armMissingAt = null;
  if ((state.phase === 'descent' || state.phase === 'down') && angle <= 100 && Math.abs(state.angularVelocity) <= 200) c.slowBottom = true;
  if (state.phase === 'descent' || state.phase === 'down' || state.phase === 'ascent') {
    if (c.frames > 450 || (c.startedAt !== null && now - c.startedAt > 20)) {
      state.phase = 'up'; resetCandidate(state); event = 'reset';
    } else collect(state, features);
  }
  if (angle >= 134) state.topShoulder = state.topShoulder === null ? features.shoulder.y : Math.max(state.topShoulder, features.shoulder.y);
  c = state.candidate;
  let delta: 0 | 1 = 0, shouldJudge = false;
  if (state.phase === 'waitingForUp') {
    if (angle >= 148) {
      if (state.readyAt === null) state.readyAt = now;
      if (now - state.readyAt >= 0.08) { state.phase = 'up'; state.waitingPeak = 0; }
    } else {
      state.readyAt = null; state.waitingPeak = Math.max(state.waitingPeak, angle);
      if (state.waitingPeak >= 112 && angle <= state.waitingPeak - 12) startDescent(state, features, now);
    }
  } else if (state.phase === 'up') {
    if (angle < 134) startDescent(state, features, now);
  } else if (state.phase === 'descent') {
    confirmMinimum(c, angle, now);
    if (angle <= 100) {
      c.highFrames = 0; c.partialHighFrames = 0;
      if (c.belowAt === null) c.belowAt = now;
      if (now - c.belowAt >= 0.06) state.phase = 'down';
    } else if (angle > 150) {
      c.highFrames++;
      if (c.highFrames >= 3) {
        const missing = state.mode === 'full' && c.confirmedMin <= 108 && c.gapEvidence;
        const geometry = state.mode === 'full' && geometricEvidence(state);
        c.geometryCompletion = geometry && c.confirmedMin > 100;
        shouldJudge = (c.confirmedMin <= 100 || missing || geometry) && angle >= 148;
        if (!shouldJudge) { state.phase = 'waitingForUp'; resetCandidate(state); event = 'reset'; }
      }
    } else {
      c.highFrames = 0; c.belowAt = null;
      if (angle > 134) {
        c.partialHighFrames++;
        if (c.partialHighFrames >= 3) {
          c.partialHighFrames = 0;
          const missing = state.mode === 'full' && c.confirmedMin <= 108 && c.gapEvidence;
          const geometry = state.mode === 'full' && geometricEvidence(state);
          c.geometryCompletion = geometry && c.confirmedMin > 100;
          shouldJudge = missing || geometry;
          if (!shouldJudge) { state.phase = 'waitingForUp'; resetCandidate(state); event = 'reset'; }
        }
      } else c.partialHighFrames = 0;
    }
  } else if (state.phase === 'down') {
    confirmMinimum(c, angle, now);
    if (angle > 110) { state.phase = 'ascent'; c.ascentPeak = angle; }
  } else {
    c.ascentPeak = Math.max(c.ascentPeak, angle);
    shouldJudge = (angle >= 148 && Math.abs(state.angularVelocity) <= 500)
      || (c.ascentPeak >= 112 && angle <= c.ascentPeak - 12)
      || (c.ascentPeak >= 112 && angle <= 100);
    if (!shouldJudge && angle <= 100) state.phase = 'down';
  }
  if (shouldJudge) {
    delta = finishCandidate(state, now, input.deviceMotion ?? 0) ? 1 : 0;
    event = delta === 1 ? 'accepted' : 'rejected';
  }
  // Update baselines after validation; the tracker consumes the previous frame's baseline.
  if (features.shoulderW !== null && features.shoulderW > 0) {
    state.widthHistory.push(features.shoulderW);
    if (state.widthHistory.length > 24) state.widthHistory.shift();
    const widths = ordered(state.widthHistory);
    state.medianShoulderWidth = widths[Math.floor(widths.length / 2)]!;
    state.shoulderWidthBaseline = widths[Math.min(widths.length - 1, Math.floor(widths.length * 3 / 4))]!;
  }
  state.shoulderHistory.push(features.shoulder.y);
  if (state.shoulderHistory.length > 150) state.shoulderHistory.shift();
  return makeResult(state, features, delta, event);
}
